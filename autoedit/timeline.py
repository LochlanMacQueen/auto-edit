"""Build a whole Palmier timeline from one JSON plan (the agent decides the plan,
this does the thirty tool calls deterministically), and export it."""
import time
from pathlib import Path

from . import palmier as P


def _media_map():
    assets = P.call("get_media", {}).get("assets", [])
    m = {}
    for a in assets:
        m[a["name"]] = a["id"]
        m[Path(a["name"]).stem] = a["id"]
    return m


def open_project(name: str, create: bool = True) -> dict:
    lst = P.call("manage_project", {"action": "list"})
    projects = lst.get("projects", []) if isinstance(lst, dict) else []
    target = next((p for p in projects if p.get("name") == name), None)
    if target is None:
        if not create:
            raise RuntimeError(f"Palmier project '{name}' not found; existing: {[p.get('name') for p in projects]}")
        r = P.call("manage_project", {"action": "create", "name": name})
        if isinstance(r, dict) and r.get("error"):
            raise RuntimeError(f"could not create project: {r['error']}")
        lst = P.call("manage_project", {"action": "list"})
        projects = lst.get("projects", [])
        target = next((p for p in projects if p.get("name") == name), None)
        if target is None:
            raise RuntimeError(f"project '{name}' still missing after create: {r}")
    for p in projects:
        if p.get("isOpen") and p.get("id") != target.get("id"):
            P.call("manage_project", {"action": "close", "id": p["id"]})
    if not target.get("isOpen"):
        P.call("manage_project", {"action": "open", "id": target["id"]})
    return target


def ensure_media(paths: list[str], folder: str | None = None) -> dict:
    media = _media_map()
    missing = [p for p in paths if Path(p).stem not in media and Path(p).name not in media]
    for p in missing:
        args = {"source": {"path": str(p)}}
        if folder:
            args["folder"] = folder
        P.call("import_media", args)
    if missing:
        time.sleep(1.0)
        media = _media_map()
    return media


def build(plan: dict) -> dict:
    fps = int(plan.get("fps", 60))
    W, H = int(plan.get("width", 1080)), int(plan.get("height", 1920))
    open_project(plan["project"])
    P.call("set_project_settings", {"fps": fps, "width": W, "height": H})
    takes = [s["take"] for s in plan["sequence"]]
    ov_specs = plan.get("overlays", [])
    ov_paths = []
    for o in ov_specs:
        ov_paths += o.get("images", []) + ([o["image"]] if o.get("image") else [])
    media = ensure_media(takes, plan.get("media_folder"))
    if ov_paths:
        media = ensure_media(ov_paths, plan.get("overlay_folder", "Overlays"))
    tl = P.call("create_timeline", {"name": plan["timeline"]})
    tid = tl.get("timelineId") if isinstance(tl, dict) else None
    if tid:
        P.call("set_active_timeline", {"timelineId": tid})

    def ref(path):
        k = Path(path).stem
        if k in media:
            return media[k]
        if Path(path).name in media:
            return media[Path(path).name]
        raise RuntimeError(f"media not found in Palmier library: {path}")

    entries, f, sections, order = [], 0, {}, []
    for item in plan["sequence"]:
        st = f
        for s, e in item["spans"]:
            n = round((e - s) * fps)
            if n <= 0:
                continue
            entries.append({"mediaRef": ref(item["take"]), "startFrame": f, "source": [round(s, 3), round(s + n / fps, 4)]})
            f += n
        name = item.get("section") or Path(item["take"]).stem
        sections.setdefault(name, [st, f])
        sections[name][1] = f
        order.append(name)
    end = f
    P.call("add_clips", {"entries": entries})
    tlc = P.call("get_timeline", {})
    vtracks = [t for t in tlc.get("tracks", []) if t.get("kind", "video") != "audio"]
    fixed = 0
    if vtracks:
        clips = vtracks[0].get("clips", [])
        for a, b in zip(clips, clips[1:]):
            if b["frames"][0] > a["frames"][1]:
                P.call("set_clip_properties", {"clipIds": [a["id"]], "durationFrames": b["frames"][0] - a["frames"][0]})
                fixed += 1
    ov, warnings = [], []
    for o in ov_specs:
        sec = o.get("section")
        if sec not in sections:
            warnings.append(f"overlay references unknown section {sec!r}"); continue
        st, en = sections[sec]
        gap = round(float(o.get("gap", 0.4)) * fps)
        mode = o.get("mode", "sequence" if o.get("images") else "at")
        if mode == "tile":
            imgs = o["images"]; n = len(imgs); each = (en - st - (n - 1) * gap) // n
            for k, im in enumerate(imgs):
                a = st + k * (each + gap)
                ov.append({"mediaRef": ref(im), "startFrame": a, "endFrame": en if k == n - 1 else a + each})
        elif mode == "sequence":
            imgs = o["images"]; each = round(float(o.get("each", 3.0)) * fps); a = st + round(float(o.get("offset", 0)) * fps)
            for k, im in enumerate(imgs):
                last = k == len(imgs) - 1
                b = en if (last and o.get("last_to_end", True)) else min(a + each, en)
                if b - a >= fps // 4:
                    ov.append({"mediaRef": ref(im), "startFrame": a, "endFrame": b})
                a = b + gap
                if a >= en:
                    break
        else:  # "at": one image at offset for duration / until end
            a = st + round(float(o.get("offset", 0)) * fps)
            if o.get("after_previous_gap") is not None and ov:
                a = ov[-1]["endFrame"] + round(float(o["after_previous_gap"]) * fps)
            b = en if o.get("until") in ("end", "section_end", None) and o.get("duration") is None else min(a + round(float(o.get("duration", 3.0)) * fps), en)
            if b - a >= fps // 4:
                ov.append({"mediaRef": ref(o["image"]), "startFrame": a, "endFrame": b})
            else:
                warnings.append(f"overlay {Path(o['image']).name} skipped: no room in {sec}")
    if ov:
        P.call("add_clips", {"entries": ov})
    return {"timelineId": tid, "frames": end, "seconds": round(end / fps, 3), "fps": fps,
            "sections": {k: {"frames": v, "seconds": [round(v[0] / fps, 3), round(v[1] / fps, 3)]} for k, v in sections.items()},
            "order": order, "gap_fixes": fixed, "overlays": len(ov), "warnings": warnings}


def export(timeline_id: str | None, out_path: str, codec="H.264", timeout_s=900) -> dict:
    args = {"mode": "video", "codec": codec, "resolution": "Match Timeline", "outputPath": str(out_path)}
    if timeline_id:
        args["timelineId"] = timeline_id
    r = P.call("export_project", args)
    job = r.get("jobId") if isinstance(r, dict) else None
    t0 = time.time(); status = None
    while time.time() - t0 < timeout_s:
        ex = P.call("manage_exports", {"action": "list"})
        e = [x for x in ex.get("exports", []) if x.get("jobId") == job] if isinstance(ex, dict) else []
        status = e[0].get("status") if e else None
        if status in ("completed", "failed", "canceled", "cancelled"):
            break
        time.sleep(3)
    return {"jobId": job, "status": status, "path": str(out_path), "response": r if not job else None}
