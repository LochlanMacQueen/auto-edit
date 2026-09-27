"""The auto-edit MCP server + dashboard. One process, one port (4747):
  /mcp        streamable-HTTP MCP (Claude Code, Claude Desktop via the .mcpb shim, ChatGPT via a tunnel)
  /           dashboard: setup, review queue, phone, posting queue, connect
"""
import base64
import io
import json
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.types import ImageContent, TextContent
from starlette.requests import Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response

from . import __version__, config, media, palmier as PM, review as R, timeline as TL, phone as PH
from .config import HOME, PORT, REPO, UGC

WEB = Path(__file__).parent / "web"
INSTRUCTIONS = (REPO / "autoedit" / "AGENT.md").read_text() if (REPO / "autoedit" / "AGENT.md").exists() else ""

mcp = MCPServer("auto-edit", version=__version__, instructions=INSTRUCTIONS,
                description="Turns raw talking-head takes into finished reels: Palmier Pro edit, Instagram Edits captions/headers on a real iPhone, review queue, scheduled posting.")


def _img(path) -> list:
    data = base64.b64encode(Path(path).read_bytes()).decode()
    mt = "image/jpeg" if str(path).lower().endswith((".jpg", ".jpeg")) else "image/png"
    return [ImageContent(type="image", data=data, mimeType=mt), TextContent(type="text", text=str(path))]


# ================================================================ setup / connect
@mcp.tool()
def setup_status() -> dict:
    """Check every dependency: ffmpeg, whisper, Palmier Pro's MCP, the iPhone bridge (WebDriverAgent), Instagram Edits reachability. Call this first in a session and fix ✗ items before editing."""
    out = {"ffmpeg": bool(shutil.which("ffmpeg")), "ffprobe": bool(shutil.which("ffprobe"))}
    try:
        import mlx_whisper  # noqa: F401
        out["whisper"] = True
    except Exception:
        out["whisper"] = False
    out["palmier_pro"] = PM.is_up()
    out["phone"] = PH.status()
    busy = next((j for j in PH.jobs() if j["status"] in ("running", "sharing")), None)
    if busy:
        out["phone"]["busy"] = f"job {busy['id']} ({busy['title']}) is driving the phone"
        out["phone"]["ready"] = True
    out["home"] = str(HOME)
    out["dashboard"] = f"http://127.0.0.1:{PORT}"
    out["agent_connected"] = (time.time() - LAST_AGENT["t"]) < 900 or _claude_desktop_has_extension()
    out["last_agent_call"] = LAST_AGENT["t"] or None
    out["claude_desktop_extension"] = _claude_desktop_has_extension()
    out["ok"] = out["ffmpeg"] and out["whisper"] and out["palmier_pro"]
    out["ready_to_post"] = out["ok"] and bool(out["phone"].get("ready"))
    out["next"] = ("all good" if out["ready_to_post"] else
                   "Palmier Pro must be open (MCP on :19789)" if not out["palmier_pro"] else
                   "phone bridge not ready: open the dashboard → Phone" if not out["phone"].get("ready") else "install ffmpeg / whisper")
    return out


@mcp.tool()
def setup_guide() -> str:
    """The human setup steps (what the dashboard shows). Walk the person through only the ✗ items from setup_status."""
    return (WEB / "setup.md").read_text() if (WEB / "setup.md").exists() else "See the dashboard."


# ================================================================ project & media
@mcp.tool()
def project_create(name: str, folder: str) -> dict:
    """Register a project: `folder` is the person's folder of takes/images/song. Creates <folder>/auto-edit/{overlays,exports,finished} for our outputs and returns an inventory (videos with duration, images, audio)."""
    root = Path(folder).expanduser()
    if not root.is_dir():
        return {"error": f"not a folder: {root}"}
    for d in ("overlays", "exports", "finished"):
        (root / "auto-edit" / d).mkdir(parents=True, exist_ok=True)
    inv = _inventory(root)
    proj = {"name": name, "folder": str(root), "created": time.time(), "palmier_project": name}
    (HOME / "projects" / f"{_slug(name)}.json").write_text(json.dumps(proj, indent=1))
    return {**proj, **inv}


def _slug(s):
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in s).strip("-").lower() or "project"


def _inventory(root: Path) -> dict:
    vids, imgs, auds = [], [], []
    for p in sorted(root.rglob("*")):
        if "auto-edit" in p.parts or p.name.startswith("."):
            continue
        ext = p.suffix.lower()
        if ext in (".mov", ".mp4", ".m4v"):
            vids.append(media.probe(p))
        elif ext in (".jpg", ".jpeg", ".png", ".heic", ".webp"):
            imgs.append(str(p))
        elif ext in (".mp3", ".wav", ".m4a", ".aac"):
            auds.append(str(p))
    return {"videos": vids, "images": imgs, "audio": auds}


@mcp.tool()
def project_list() -> list:
    """Projects registered on this machine."""
    return [json.loads(p.read_text()) for p in sorted((HOME / "projects").glob("*.json"))]


@mcp.tool()
def takes_overview(folder: str) -> list:
    """Transcribe every video in a folder (cached) and return duration + the first ~14 words of each, so you can classify takes (hook / section / call-to-action / other) and propose names. Slow the first time (model load)."""
    out = []
    for p in sorted(Path(folder).expanduser().iterdir()):
        if p.suffix.lower() in (".mov", ".mp4", ".m4v") and not p.name.startswith("."):
            t = media.transcribe(p)
            words = t["text"].split()
            out.append({"path": str(p), "duration": media.probe(p)["duration"], "opening": " ".join(words[:14]), "words": len(words)})
    return out


@mcp.tool()
def transcribe(path: str) -> dict:
    """Full word-timestamped transcript of one file (cached by size)."""
    return media.transcribe(Path(path).expanduser())


@mcp.tool()
def rename_take(path: str, new_stem: str) -> dict:
    """Rename a take on disk (keeps the extension). Do this BEFORE importing into Palmier — Palmier references media in place."""
    p = Path(path).expanduser(); q = p.with_name(new_stem + p.suffix)
    if q.exists():
        return {"error": f"exists: {q}"}
    p.rename(q)
    return {"from": str(p), "to": str(q)}


@mcp.tool()
def speech_spans(path: str, noise_db: float = -28, lead: float = 0.07, tail: float = 0.13, validate: bool = True) -> dict:
    """Dead-space detection for one take: speech spans (source seconds) after padding, each transcribed ALONE when validate=true. Spans flagged drop=true have no words; possible_false_start=true means the next span restarts the same sentence — cut the flagged one. Pass the kept spans straight into build_timeline."""
    return media.speech_spans(Path(path).expanduser(), noise_db=noise_db, lead=lead, tail=tail, validate=validate)


@mcp.tool()
def overlay_band(image: str, out: str, x: int = 50, y: int = 232, w: int = 980, h: int = 497, y_offset: float = 0.5,
                 canvas_w: int = 1080, canvas_h: int = 1920) -> str:
    """Make a full-frame 1080x1920 transparent PNG with `image` centre-cropped into the band (x,y,w,h). Default band = the 2:1 top band used by the subject-edition reels; career edition used 16:9 at x=110,y=126,w=860,h=484. y_offset picks which part of a tall image survives the crop (0 top … 1 bottom)."""
    return media.overlay_band(Path(image).expanduser(), Path(out).expanduser(), (x, y, w, h), canvas=(canvas_w, canvas_h), y_offset=y_offset)


@mcp.tool()
def overlay_fit(image: str, out: str, max_w: int = 900, max_h: int | None = None, bottom: int | None = 610, top: int | None = None,
                canvas_w: int = 1080, canvas_h: int = 1920) -> str:
    """Full-frame PNG with `image` scaled to fit (aspect kept), centred, bottom edge at `bottom` px (or top edge at `top`). Used for app-store / score cards on the call-to-action."""
    return media.overlay_fit(Path(image).expanduser(), Path(out).expanduser(), max_w, max_h, bottom, top, canvas=(canvas_w, canvas_h))


# ================================================================ palmier
@mcp.tool()
def palmier_tools() -> list:
    """Palmier Pro's own MCP tools with full input schemas (get_timeline, add_clips, set_clip_properties, split_clips, remove_silence, add_captions, add_texts, export_project, …). Call any of them through `palmier`. Prefer build_timeline for assembling a reel; use these for adjustments."""
    return PM.tools()


@mcp.tool()
def palmier(tool: str, arguments: dict[str, Any] | None = None) -> Any:
    """Call one Palmier Pro tool by name with its arguments (see palmier_tools). Palmier must be open. Rules learned the hard way: add_clips without trackIndex creates a track and shifts indices (re-read get_timeline); same-track overlaps replace; the active timeline follows the app — set_active_timeline first; media is referenced in place (rename before import)."""
    return PM.call(tool, arguments or {})


@mcp.tool()
def build_timeline(plan: dict[str, Any]) -> dict:
    """Build a complete Palmier timeline from a plan and return section boundaries.
plan = {
 "project": "Palmier project name (created if missing)", "timeline": "video1", "fps": 60, "width": 1080, "height": 1920,
 "sequence": [ {"take": "/abs/hook.MOV", "spans": [[0.2,2.46]], "section": "hook"},
               {"take": "/abs/engineer.MOV", "spans": [[0,3.6],[6.19,8.27]], "section": "engineer"}, … , {"take": "/abs/CTA.MOV", "spans": [...], "section": "CTA"} ],
 "overlays": [ {"section": "engineer", "images": ["/abs/o1.png","/abs/o2.png"], "mode": "sequence", "each": 3.0, "gap": 0.4},   # image1 3.0s, gap, image2 to section end
               {"section": "engineer", "images": [3 pngs], "mode": "tile", "gap": 0.35},                                       # equal thirds
               {"section": "CTA", "image": "/abs/app_store.png", "mode": "at", "offset": 2.26, "duration": 3.0},               # offset = seconds into the section
               {"section": "CTA", "image": "/abs/score.png", "mode": "at", "after_previous_gap": 0.35, "until": "end"} ] }
Spans are source seconds (from speech_spans, kept ones only); clips are butted with no gaps; overlays must be full-frame PNGs (overlay_band / overlay_fit) so no transforms are needed. The App Store card must land on the words "I made an app/test that does exactly that" — take the offset from the transcript."""
    return TL.build(plan)


@mcp.tool()
def export_timeline(out_path: str, timeline_id: str | None = None, codec: str = "H.264", resolution: str = "Match Timeline") -> dict:
    """Export the (active or given) Palmier timeline to out_path and wait for it. Defaults H.264 'Match Timeline'. For 4K60 sources use codec='H.265', resolution='4K' (Palmier's H.264 path silently drops a 4K60 timeline to 30 fps). Then run `bake` — Palmier's first exported frame is corrupt and music is added there."""
    Path(out_path).expanduser().parent.mkdir(parents=True, exist_ok=True)
    return TL.export(timeline_id, str(Path(out_path).expanduser()), codec=codec, resolution=resolution)


@mcp.tool()
def bake(src: str, out: str, music: str | None = None, music_db: float = -16.0, fade_out: float = 2.0, fps: int = 60, encoder: str = "auto") -> dict:
    """Finish an export: trim the corrupt first frame, force fps, bake the song under the voice (looped if shorter, faded out). This is the ONLY place sound is added — never in Edits. encoder: 'auto' (libx264 crf 19 for ≤1080p, VideoToolbox H.264 30 Mbps for 4K), 'x264' or 'videotoolbox'. Returns the probe of the finished file."""
    Path(out).expanduser().parent.mkdir(parents=True, exist_ok=True)
    return media.bake(Path(src).expanduser(), Path(out).expanduser(), music and Path(music).expanduser(), music_db, fade_out, fps, encoder=encoder)


@mcp.tool()
def verify_video(path: str, expected_words: str | None = None) -> dict:
    """Acceptance test for a finished file: transcript (read it end to end), speech coverage (≈1.0 means dead space is gone), resolution/fps, and words missing vs expected_words if given. Do not call a video done without this."""
    return media.verify(Path(path).expanduser(), expected_words)


@mcp.tool()
def video_frame(path: str, t: float) -> list:
    """A frame of a video at t seconds (image) — look at overlays, cards, framing."""
    out = HOME / "tmp" / f"frame-{int(t*1000)}-{Path(path).stem}.jpg"
    return _img(media.frame(Path(path).expanduser(), t, out))


@mcp.tool()
def contact_sheet(path: str, cols: int = 6, rows: int = 3, every: float = 1.0) -> list:
    """Tiled frames every `every` seconds — the quickest way to see a whole reel or a reference video."""
    out = HOME / "tmp" / f"sheet-{Path(path).stem}.jpg"
    return _img(media.contact_sheet(Path(path).expanduser(), out, cols, rows, every))


# ================================================================ formats
@mcp.tool()
def format_save(name: str, spec: dict[str, Any]) -> dict:
    """Save a reusable format (structure, overlay rules, header/caption rules, music, posting defaults) once the person approved a video. Free-form JSON; include everything needed to reproduce the look with new takes."""
    p = HOME / "formats" / f"{_slug(name)}.json"
    p.write_text(json.dumps({"name": name, "saved": time.time(), "spec": spec}, indent=1))
    return {"saved": str(p)}


@mcp.tool()
def format_list() -> list:
    """Saved formats (name + spec)."""
    return [json.loads(p.read_text()) for p in sorted((HOME / "formats").glob("*.json"))]


# ================================================================ review
@mcp.tool()
def review_submit(title: str, video: str, notes: str = "", images: list[str] | None = None) -> dict:
    """Put a finished video in the dashboard's Review section for the person to watch and approve or send back with feedback. Then call review_wait."""
    item = R.submit(title, str(Path(video).expanduser()), notes, images)
    return {**item, "url": f"http://127.0.0.1:{PORT}/#review"}


@mcp.tool()
def review_wait(review_id: str, timeout_s: int = 540) -> dict:
    """Block until the person decides (approved / changes) or timeout; returns the item with `feedback`. Call again if still pending."""
    return R.wait(review_id, timeout_s) or {"error": "unknown review id"}


@mcp.tool()
def review_list() -> list:
    """All review items, newest first."""
    return R.all_items()


# ================================================================ phone / posting
@mcp.tool()
def phone_status() -> dict:
    """iPhone bridge: WebDriverAgent ready?, iOS version, foreground app, registered devices."""
    return PH.status()


@mcp.tool()
def phone_screenshot() -> list:
    """Current iPhone screen (image)."""
    return _img(PH.screenshot(HOME / "tmp" / "phone.png"))


@mcp.tool()
def reel_job(video: str, headers: dict[str, Any], caption: str, mode: str = "normal", not_before: str | None = None,
             review: bool = True, post: bool = True, title: str | None = None, take_over: bool = False) -> dict:
    """Queue one finished video through Instagram Edits on the phone and post it.
headers = {"hook": ["white line", "gold line"], "sections": [["Engineer", "115-130IQ"], …], "cta": ["Do you know your IQ?", null]}
  — section names must be the words that START each section in the transcript (they are matched against Edits' captions); header text always comes from THIS video's transcript.
mode = "normal" | "trial" (trial reel). not_before = ISO local time ("2026-09-26T21:30") or null. review=true parks the reel in the Review section (composer left open) until approved. If Edits already has a project open on the phone the job fails fast (someone's work) unless take_over=true. Jobs run one at a time (~35–40 min each); check job_status."""
    nb = None
    if not_before:
        nb = time.mktime(time.strptime(not_before[:16], "%Y-%m-%dT%H:%M"))
    j = PH.add_job(str(Path(video).expanduser()), headers, caption, mode, nb, review, title, post, take_over)
    return {"id": j["id"], "status": j["status"], "queue_position": [x["id"] for x in PH.jobs() if x["status"] in ("queued", "running")].index(j["id"])}


@mcp.tool()
def job_status(job_id: str, tail: int = 15) -> dict:
    """Status, stage and last log lines of a reel job."""
    j = PH.get_job(job_id)
    if not j:
        return {"error": "unknown job"}
    return {k: v for k, v in j.items() if k != "log"} | {"log": j["log"][-tail:]}


@mcp.tool()
def queue_list() -> list:
    """All reel jobs (queued / running / waiting_review / waiting_time / done / failed)."""
    return [{k: v for k, v in j.items() if k not in ("log", "headers")} for j in PH.jobs()]


@mcp.tool()
def job_cancel(job_id: str) -> dict:
    """Cancel a queued or waiting job."""
    return {"cancelled": PH.cancel(job_id)}


# ================================================================ dashboard routes
def _page():
    return (WEB / "index.html").read_text()


@mcp.custom_route("/", methods=["GET"])
async def home(_: Request):
    return HTMLResponse(_page(), headers={"cache-control": "no-store"})


@mcp.custom_route("/api/status", methods=["GET"])
async def api_status(_: Request):
    return JSONResponse(await run_in_threadpool(setup_status))


@mcp.custom_route("/api/review", methods=["GET"])
async def api_review(_: Request):
    return JSONResponse(await run_in_threadpool(R.all_items))


@mcp.custom_route("/api/review/{item_id}/decide", methods=["POST"])
async def api_decide(request: Request):
    body = await request.json()
    item = R.decide(request.path_params["item_id"], body.get("status", "changes"), body.get("feedback", ""))
    return JSONResponse(item or {"error": "unknown"})


@mcp.custom_route("/api/queue", methods=["GET"])
async def api_queue(_: Request):
    return JSONResponse([{k: v for k, v in j.items() if k != "headers"} for j in PH.jobs()])


@mcp.custom_route("/api/queue/{job_id}/cancel", methods=["POST"])
async def api_cancel(request: Request):
    return JSONResponse({"cancelled": PH.cancel(request.path_params["job_id"])})


@mcp.custom_route("/api/project/new", methods=["POST"])
async def api_project_new(request: Request):
    """Create ~/Movies/auto-edit/<name> and reveal it in Finder — step 1 of Make a video."""
    body = await request.json()
    name = _slug(str(body.get("name", "")).strip())
    if not name:
        return JSONResponse({"error": "name required"})
    folder = Path.home() / "Movies" / "auto-edit" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "auto-edit").mkdir(exist_ok=True)
    import subprocess
    subprocess.Popen(["open", str(folder)])
    return JSONResponse({"folder": str(folder)})


@mcp.custom_route("/connect/install-claude", methods=["POST"])
async def install_claude(_: Request):
    """Write the .mcpb next to the data dir and hand it to Claude Desktop (registered handler)."""
    import subprocess, zipfile as zf
    out = HOME / "auto-edit.mcpb"; src = REPO / "mcpb-autoedit"
    with zf.ZipFile(out, "w", zf.ZIP_DEFLATED) as z:
        for p in src.rglob("*"):
            if p.is_file():
                z.write(p, str(p.relative_to(src)))
    r = subprocess.run(["open", str(out)], capture_output=True, text=True)
    if r.returncode:
        return JSONResponse({"error": r.stderr.strip() or "open failed", "path": str(out)})
    return JSONResponse({"opened": True, "path": str(out)})


@mcp.custom_route("/api/formats", methods=["GET"])
async def api_formats(_: Request):
    return JSONResponse(format_list())


@mcp.custom_route("/file", methods=["GET"])
async def api_file(request: Request):
    p = Path(request.query_params.get("path", "")).expanduser()
    allowed = [Path.home(), Path("/Volumes"), HOME]
    if not p.is_file() or not any(str(p).startswith(str(a)) for a in allowed):
        return PlainTextResponse("not found", status_code=404)
    return FileResponse(str(p))


@mcp.custom_route("/phone/shot.jpg", methods=["GET"])
async def phone_shot(_: Request):
    try:
        out = HOME / "tmp" / "live.png"
        await run_in_threadpool(PH.screenshot, out)
        return Response(out.read_bytes(), media_type="image/png", headers={"cache-control": "no-store"})
    except Exception as e:
        return PlainTextResponse(str(e), status_code=503)


@mcp.custom_route("/connect/auto-edit.mcpb", methods=["GET"])
async def mcpb(_: Request):
    src = REPO / "mcpb-autoedit"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in src.rglob("*"):
            if p.is_file():
                z.write(p, str(p.relative_to(src)))
    return Response(buf.getvalue(), media_type="application/octet-stream",
                    headers={"content-disposition": "attachment; filename=auto-edit.mcpb"})


@mcp.custom_route("/connect/info", methods=["GET"])
async def connect_info(_: Request):
    return JSONResponse({
        "mcp_url": f"http://127.0.0.1:{PORT}/mcp",
        "claude_code": f"claude mcp add --transport http auto-edit http://127.0.0.1:{PORT}/mcp",
        "claude_desktop": "download auto-edit.mcpb and double-click it (Claude Desktop → Settings → Extensions)",
        "chatgpt": f"brew install cloudflared && cloudflared tunnel --url http://127.0.0.1:{PORT}  → paste the https URL + /mcp as a ChatGPT connector (Settings → Connectors → Advanced → Developer mode)",
    })


LAST_AGENT = {"t": 0.0}


def _claude_desktop_has_extension() -> bool:
    ext = Path.home() / "Library/Application Support/Claude/Claude Extensions"
    try:
        return any("auto-edit" in p.name for p in ext.iterdir())
    except Exception:
        return False


def app():
    from starlette.middleware.base import BaseHTTPMiddleware

    class AgentActivity(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.url.path.startswith("/mcp"):
                LAST_AGENT["t"] = time.time()
            return await call_next(request)

    a = mcp.streamable_http_app(json_response=True, stateless_http=True)
    a.add_middleware(AgentActivity)
    return a
