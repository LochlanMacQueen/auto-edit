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
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone  # noqa: E402
import edits_timeline as T  # noqa: E402
import edits_headers2 as H  # noqa: E402

EDITS = "com.burbn.basel"
INSTAGRAM = "com.burbn.instagram"
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
    tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs", "_import.json")
    open(tmp, "w").write(body)
    out = subprocess.run(["curl", "-s", "--max-time", "300", "-X", "POST", f"{WDA}/wda/import-media",
                          "-H", "content-type: application/json", "--data-binary", "@" + tmp],
                         capture_output=True, text=True).stdout
    os.remove(tmp)
    log("import:", out.replace("\n", "")[:120])
    time.sleep(3)


def open_edits_fresh():
    """A WDA session is created BEFORE Edits opens: creating one mid-edit throws
    the app to the home screen and loses the editor."""
    if not phone.session():
        phone.start_session()
    phone.launch(EDITS)
    time.sleep(5)
    for _ in range(4):
        if phone.find("Projects", exact=True):
            return
        if phone.find("Choose where to share"):        # post-export share sheet: back to the editor
            phone.tap(20, 60); time.sleep(4)
        c = phone.find("Close project")
        if c:
            phone.tap(c["x"], c["y"]); time.sleep(3)
            keep = phone.find("Save") or phone.find("Keep")
            if keep:
                phone.tap(keep["x"], keep["y"]); time.sleep(3)
        else:
            phone.launch(EDITS); time.sleep(4)


def new_project_from_newest():
    phone.tap(342, 699); time.sleep(3)                    # +
    g = wait_for("Gallery", 10)
    phone.tap(g["x"], g["y"]); time.sleep(5)
    phone.tap(62, 202); time.sleep(2)                     # newest cell
    phone.tap(352, 94); time.sleep(10)                    # blue check
    if not wait_for("Next", 30, kind="Button"):
        raise RuntimeError("editor did not open")
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


def caption_field():
    tv = [e for e in phone.elements() if e.get("type") == "TextView" and 300 < (e.get("rect") or {}).get("y", 0) < 520]
    return tv[0] if tv else None


def export_and_compose(caption, post=False):
    """Next -> (Export in HD if asked) -> wait -> Instagram. Instagram must be
    KILLED first: if it is already running the handoff lands on the main feed
    instead of the reel composer."""
    T.deselect()
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
        open_edits_fresh()
        new_project_from_newest()
        captions()
        headers(spec, video)
    export_and_compose(caption, post=post)
    log("DONE %s in %.0fs" % (key, time.time() - t0))
