#!/usr/bin/env python3
"""One finished video through Instagram Edits on a real iPhone:
import -> new project -> auto captions -> headers -> export HD -> Instagram composer.

Usage:
  python3 ugc/edits_pipeline.py <video.mp4> <key> [--headers headers.json] [--caption "text"]
                                [--stay | --post] [--no-import] [--resume-headers] [--resume-sections]

  <key> indexes headers.json (see examples/headers.example.json):
    {"<key>": {"hook": ["line 1 (white)", "line 2 (gold)"],
               "sections": [["Section name", "small gold line"], ...],
               "cta": ["CTA header", null],
               "caption": "Instagram caption"}}

  --stay   leave the reel in the Instagram composer (default: Save draft)
  --post   tap Share (a normal reel). For a trial reel use ig_share_trial.py after --stay.

Requirements: the dashboard's WebDriverAgent for this phone on 127.0.0.1:8100, Instagram
Edits (com.burbn.basel) and Instagram installed and logged in. Header geometry lives in
edits_text.py / edits_headers2.py; the runbook is docs/edits-app-runbook.md.
"""
import base64
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone  # noqa: E402
import edits_timeline as T  # noqa: E402
import edits_headers2 as H  # noqa: E402

EDITS = "com.burbn.basel"
INSTAGRAM = "com.burbn.instagram"
EXPECTED_DURATION = None           # set from the video file in __main__
WDA = phone.WDA


def arg(flag, default=None):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def log(*a):
    print(" ".join(str(x) for x in a), flush=True)


def wait_for(label, timeout=20, kind=None):
    t0 = time.time()
    while time.time() - t0 < timeout:
        e = phone.find(label, kind=kind)
        if e:
            return e
        time.sleep(1.0)
    return None


def typed_fast_verified(text):
    """Long Instagram caption: one /wda/keys call, then read the field back and
    fall back to one tap per key if anything was dropped."""
    phone.type_fast(text); time.sleep(1.0)
    tv = [e for e in phone.elements() if e.get("type") == "TextView" and (e.get("rect") or {}).get("y", 0) > 90]
    got = str(tv[0].get("value") or "") if tv else ""
    if got.strip() != text.strip():
        kb = phone.wait_keyboard(timeout=10)
        phone.clear_text(kb=kb, n=len(got) + 6); time.sleep(0.5)
        phone.type_taps(text, kb=kb); time.sleep(0.8)


# ---------------------------------------------------------------- steps
def import_video(path):
    """Push the file into the phone's Photos library through WDA."""
    data = open(path, "rb").read()
    body = json.dumps({"name": os.path.basename(path), "mimeType": "video/mp4",
                       "data": base64.b64encode(data).decode()})
    tmp = os.path.join(phone._state_dir(), "_import.json")
    open(tmp, "w").write(body)
    try:
        for attempt in range(1, 4):
            out = subprocess.run(["curl", "-s", "--max-time", "300", "-X", "POST", f"{WDA}/wda/import-media",
                                  "-H", "content-type: application/json", "--data-binary", "@" + tmp],
                                 capture_output=True, text=True).stdout
            log("import:", out.replace("\n", "")[:120])
            try:
                ok = "error" not in (json.loads(out).get("value") or {})
            except Exception:
                ok = False
            if ok:
                time.sleep(3); return
            time.sleep(10 * attempt)                       # iCloud/Photos hiccup: wait and retry
        raise RuntimeError("Photos import failed 3 times — refusing to build on whatever video is newest")
    finally:
        os.remove(tmp)


def cancel_photo_picker():
    """An iOS Photos picker (Cancel / Photos / Collections / Done) left open over Edits
    swallows every tap; the Projects screen still reads as visible underneath."""
    for _ in range(3):
        if not phone.find("Collections", exact=True):
            return
        c = [n for n in phone.elements() if n.get("label") == "Cancel" and n.get("type") == "Button"]
        if c:
            r = c[0]["rect"]; phone.tap(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); time.sleep(2)


def open_edits_fresh(take_over=None):
    """A WDA session is created BEFORE Edits opens: creating one mid-edit throws
    the app to the home screen and loses the editor. If Edits already has a
    project open it is someone's work: refuse unless take_over (AUTOEDIT_TAKE_OVER=1)."""
    if take_over is None:
        take_over = os.environ.get("AUTOEDIT_TAKE_OVER") == "1"
    if not phone.session():
        phone.start_session()
    phone.launch(EDITS)
    time.sleep(5)
    for _ in range(6):
        cancel_photo_picker()
        if phone.find("Apply to track"):                     # text editor left open: commit and close it
            ds = [n for n in phone.elements() if n.get("label") == "Done" and n.get("type") == "Button"
                  and (n.get("rect") or {}).get("y", 999) < 100]
            if ds:
                r = ds[0]["rect"]; phone.tap(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); time.sleep(2.5)
            b = phone.find("back-button")
            if b:
                phone.tap(b["x"], b["y"]); time.sleep(1.5)
        if phone.find("Projects", exact=True):
            return
        if phone.find("Choose where to share"):        # post-export share sheet: back to the editor
            phone.tap(20, 60); time.sleep(4)
        c = phone.find("Close project")
        if c:
            if not take_over:
                raise RuntimeError("Instagram Edits has a project open on the phone. Finish or close it, "
                                   "or re-queue the job with take_over=true.")
            phone.tap(c["x"], c["y"]); time.sleep(3)
            keep = phone.find("Save") or phone.find("Keep") or phone.find("Save draft")
            if keep:
                phone.tap(keep["x"], keep["y"]); time.sleep(3)
        else:
            phone.launch(EDITS); time.sleep(4)
    pills = [str(n.get("label")) for n in phone.elements() if n.get("type") == "Button"
             and 470 < (n.get("rect") or {}).get("y", 0) < 720 and n.get("label") and n["label"] not in ("Hide", "Mute")]
    raise RuntimeError("Instagram Edits is busy with an open project (timeline shows: "
                       + ", ".join(repr(x)[:40] for x in pills[:3]) + "). Someone else is editing on this phone — "
                       "finish that first, then re-queue.")


def new_project_from_newest():
    g = None
    for _ in range(3):                                     # recover from a half-open sheet
        cancel_photo_picker()
        if not phone.find("Projects", exact=True):
            open_edits_fresh(take_over=True)
        phone.tap(342, 699); time.sleep(3)                # +
        g = wait_for("Gallery", 10)
        if g:
            break
        cancel_photo_picker()                             # a stray picker swallows the + tap
    if not g:
        raise RuntimeError("Edits never showed the Gallery picker")
    phone.tap(g["x"], g["y"]); time.sleep(5)
    phone.tap(62, 202); time.sleep(2)                     # newest cell
    phone.tap(352, 94); time.sleep(10)                    # blue check
    if not wait_for("Next", 30, kind="Button"):
        raise RuntimeError("editor did not open")
    if EXPECTED_DURATION:                                   # the newest gallery video must be THIS video
        clock = [str(n.get("label")) for n in phone.elements() if re.fullmatch(r"\d\d:\d\d, \d\d:\d\d", str(n.get("label") or ""))]
        if clock:
            mm, ss = clock[0].split(", ")[1].split(":"); shown = int(mm) * 60 + int(ss)
            if abs(shown - EXPECTED_DURATION) > 1.5:
                raise RuntimeError(f"new project is {shown}s but the video is {EXPECTED_DURATION:.1f}s — wrong video picked")
    log("project open")


def captions():
    c = phone.find("Captions", exact=True); phone.tap(c["x"], c["y"]); time.sleep(4)
    g = wait_for("Generate Captions", 10); phone.tap(g["x"], g["y"])
    t0 = time.time()
    while time.time() - t0 < 120:
        if T.caption_y() is not None and len([r for r in T.rows() if len(r["label"]) > 20]) >= 1:
            break
        time.sleep(3)
    T.deselect()
    log("captions in %.0fs" % (time.time() - t0))


def duration_of(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip())


def headers(spec, video):
    """Two full-length tracks (white name / gold line), split at each section."""
    H.build(spec, duration_of(video), tracks="--resume-sections" not in sys.argv)


def set_export_quality(res="4K", fps="60"):
    """Editor top-bar quality button (labelled HD/2K/4K) opens Resolution / Frame Rate /
    Colour. Rule: a 4K60 source goes out of Edits at 4K60 — never downscaled."""
    q = [n for n in phone.elements() if n.get("type") == "Button" and n.get("label") in ("HD", "2K", "4K")
         and (n.get("rect") or {}).get("y", 999) < 80]
    if not q:
        log("!! quality button not found"); return False
    r = q[0]["rect"]; phone.tap(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); time.sleep(2.5)
    for label in (res, fps):
        b = [n for n in phone.elements() if n.get("type") == "Button" and n.get("label") == label
             and 100 < (n.get("rect") or {}).get("y", 0) < 260]
        if b:
            rr = b[0]["rect"]; phone.tap(rr["x"] + rr["width"] / 2, rr["y"] + rr["height"] / 2); time.sleep(1.5)
    phone.tap(60, 400); time.sleep(2)                       # dismiss the popover
    q = [n["label"] for n in phone.elements() if n.get("type") == "Button" and n.get("label") in ("HD", "2K", "4K")
         and (n.get("rect") or {}).get("y", 999) < 80]
    log("export quality:", q, fps)
    return q == [res]


def source_is_4k(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    try:
        w, h = (int(x) for x in out.split(",")[:2]); return max(w, h) >= 3000
    except Exception:
        return False


def caption_field():
    tv = [e for e in phone.elements() if e.get("type") == "TextView" and 300 < (e.get("rect") or {}).get("y", 0) < 520]
    return tv[0] if tv else None


def export_and_compose(caption, post=False):
    """Next -> (Export in HD if asked) -> wait -> Instagram. Instagram must be
    KILLED first: if it is already running the handoff lands on the main feed
    instead of the reel composer."""
    T.deselect()
    if "--4k" in sys.argv or ("--no-4k" not in sys.argv and source_is_4k(sys.argv[1])):
        set_export_quality()
    n = phone.find("Next", exact=True, kind="Button"); phone.tap(n["x"], n["y"]); time.sleep(5)
    hd = wait_for("Export in HD", 6)
    if hd:
        phone.tap(hd["x"], hd["y"])
    t0 = time.time()
    while time.time() - t0 < 400 and (phone.find("Export progress") or not phone.find("Instagram", exact=True, kind="Button")):
        time.sleep(5)
    log("export took %.0fs" % (time.time() - t0))
    sid = phone.session()
    phone._curl(f"/session/{sid}/wda/apps/terminate", "POST", {"bundleId": INSTAGRAM}); time.sleep(2)
    ig = wait_for("Instagram", 30, kind="Button"); phone.tap(ig["x"], ig["y"])
    t0 = time.time()
    while time.time() - t0 < 90 and not phone.find("New reel"):
        time.sleep(3)
    if not phone.find("New reel"):
        raise RuntimeError("Instagram composer did not open")
    cap = caption_field()
    if caption and cap and str(cap.get("value") or "").strip() != caption:
        phone.tap(16 + 100, 409 + 30); time.sleep(3)
        cur = str(cap.get("value") or "")
        if cur and "caption" not in cur.lower():
            kb = phone.wait_keyboard(timeout=10); phone.clear_text(kb=kb, n=len(cur) + 6)
        typed_fast_verified(caption)
        ok = phone.find("OK", exact=True, kind="Button")
        if ok:
            phone.tap(ok["x"], ok["y"]); time.sleep(3)
    cap = caption_field()
    log("caption:", cap.get("value") if cap else None)
    if "--stay" in sys.argv:
        log("composer: staying (no draft, no share)"); return
    btn = "Share" if post else "Save draft"
    b = phone.find(btn, exact=True, kind="Button"); phone.tap(b["x"], b["y"]); time.sleep(8)
    log("composer:", btn)


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1].startswith("--"):
        print(__doc__); sys.exit(2)
    video, key = sys.argv[1], sys.argv[2]
    EXPECTED_DURATION = duration_of(video)
    headers_path = arg("--headers", os.environ.get("UGC_HEADERS", "headers.json"))
    spec = json.load(open(headers_path))[key]
    caption = arg("--caption", spec.get("caption", ""))
    post = "--post" in sys.argv
    t0 = time.time()
    if "--resume-headers" in sys.argv:
        if not phone.session():
            phone.start_session()
        phone.launch(EDITS); time.sleep(5)
        if phone.find("Choose where to share"):
            phone.tap(20, 60); time.sleep(4)
        if not phone.find("Next", exact=True, kind="Button"):
            c = phone.find("Close project")
            if c:                                      # some other project is open: close it first
                phone.tap(c["x"], c["y"]); time.sleep(3)
            phone.tap(62, 182); time.sleep(8)          # top-left = most recent project
            if not wait_for("Next", 30, kind="Button"):
                raise RuntimeError("could not open the most recent project")
        T.deselect()
        if "--resume-sections" not in sys.argv:
            H.clear_headers()
        headers(spec, video)
    else:
        if "--no-import" not in sys.argv:
            import_video(video)
        for attempt in (1, 2):
            open_edits_fresh(take_over=True if attempt == 2 else None)
            new_project_from_newest()
            captions()
            try:
                headers(spec, video)
                break
            except (H.HeaderLost, T.AppLeft) as e:
                if attempt == 2:
                    raise
                log("!! header lost:", e, "— exiting this project and starting a new one from the same video")
    export_and_compose(caption, post=post)
    log("DONE %s in %.0fs" % (key, time.time() - t0))
