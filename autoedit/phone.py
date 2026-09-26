"""Phone bridge: WebDriverAgent on the user's iPhone, the Instagram Edits recipe
(ugc/edits_pipeline.py) run as jobs, and a posting queue that shares each reel from
the real Instagram app when its time comes (normal or trial)."""
import json
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

from .config import HOME, REPO, UGC, WDA_URL

JOBS_FILE = HOME / "jobs" / "jobs.json"
POSTS_FILE = HOME / "jobs" / "post_times.txt"
_lock = threading.Lock()
_jobs: list[dict] = []
_worker: threading.Thread | None = None


def _ugc():
    if str(UGC) not in sys.path:
        sys.path.insert(0, str(UGC))
    import phone as ph  # ugc/phone.py
    return ph


# ---------------------------------------------------------------- status
_wda_cache = {"t": 0.0, "v": None}


def wda_status() -> dict:
    if time.time() - _wda_cache["t"] < 5 and _wda_cache["v"] is not None:
        return dict(_wda_cache["v"])
    v = _wda_status()
    _wda_cache.update(t=time.time(), v=v)
    return dict(v)


def _wda_status() -> dict:
    try:
        with urllib.request.urlopen(f"{WDA_URL}/status", timeout=3) as r:
            v = json.loads(r.read().decode()).get("value", {})
        return {"ready": bool(v.get("ready")), "ios": v.get("os", {}).get("version"),
                "device": v.get("device"), "sdk": v.get("os", {}).get("sdkVersion")}
    except Exception as e:
        return {"ready": False, "error": str(e)[:120]}


def status() -> dict:
    s = wda_status()
    if s.get("ready"):
        try:
            ph = _ugc()
            s["active_app"] = json.loads(ph._curl("/wda/activeAppInfo")).get("value", {}).get("bundleId")
        except Exception:
            pass
    try:
        devs = json.loads((REPO / "devices.json").read_text())
        s["registered_devices"] = [{"name": d.get("name"), "udid": d.get("udid")} for d in devs]
    except Exception:
        pass
    return s


def screenshot(out: Path) -> str:
    ph = _ugc()
    ph.shot(str(out))
    return str(out)


# ---------------------------------------------------------------- jobs
def _load():
    global _jobs
    try:
        _jobs = json.loads(JOBS_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        _jobs = []
    for j in _jobs:                      # a server restart orphans running jobs …
        if j["status"] in ("running", "sharing"):
            j["status"] = "failed"; j["log"].append("server restarted mid-job")
        elif j["status"] in ("waiting_review", "waiting_time"):   # … but a parked composer can resume
            j["status"] = "resume"; j["log"].append("server restarted; resuming wait")
    _save()


def _save():
    JOBS_FILE.write_text(json.dumps(_jobs, indent=1))


def add_job(video, headers, caption, mode="normal", not_before=None, review=False, title=None, post=True, take_over=False) -> dict:
    job = {"id": uuid.uuid4().hex[:8], "title": title or Path(video).stem, "video": str(video),
           "headers": headers, "caption": caption, "mode": mode, "not_before": not_before,
           "review": review, "post": post, "take_over": take_over, "status": "queued", "stage": "", "log": [],
           "created": time.time(), "review_id": None, "shared_at": None, "screens": []}
    with _lock:
        _jobs.append(job); _save()
    _ensure_worker()
    return job


def get_job(job_id):
    return next((j for j in _jobs if j["id"] == job_id), None)


def jobs():
    return _jobs


def cancel(job_id) -> bool:
    with _lock:
        j = get_job(job_id)
        if not j or j["status"] not in ("queued", "waiting_review", "waiting_time"):
            return False
        j["status"] = "cancelled"; _save()
    return True


def _log(j, msg):
    j["log"].append(f"{time.strftime('%H:%M:%S')} {msg}")
    _save()


def _ensure_worker():
    global _worker
    if _worker and _worker.is_alive():
        return
    _worker = threading.Thread(target=_loop, daemon=True, name="autoedit-phone-worker")
    _worker.start()


def _loop():
    while True:
        j = next((x for x in _jobs if x["status"] in ("queued", "resume")), None)
        if not j:
            time.sleep(3); continue
        try:
            _resume(j) if j["status"] == "resume" else _run(j)
        except Exception as e:
            j["status"] = "failed"; _log(j, f"!! {type(e).__name__}: {str(e)[:300]}")


def _run(j):
    from . import review as R
    j["status"] = "running"; j["stage"] = "edits"; _save()
    hp = HOME / "tmp" / f"headers-{j['id']}.json"
    hp.write_text(json.dumps({j["id"]: j["headers"]}))
    cmd = [sys.executable, "-u", str(UGC / "edits_pipeline.py"), j["video"], j["id"],
           "--headers", str(hp), "--caption", j["caption"], "--stay"]
    _log(j, "run: " + " ".join(Path(c).name if c.startswith("/") else c for c in cmd[2:]))
    import os
    env = dict(os.environ, AUTOEDIT_TAKE_OVER="1" if j.get("take_over") else "0")
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(REPO), env=env)
    for line in p.stdout:
        line = line.rstrip()
        if line and "Warning" not in line:
            _log(j, line)
    p.wait()
    if p.returncode != 0:
        j["status"] = "failed"; _log(j, f"edits pipeline exited {p.returncode}"); return
    shot = HOME / "jobs" / f"{j['id']}-composer.png"
    try:
        screenshot(shot); j["screens"].append(str(shot))
    except Exception:
        pass
    if j["review"]:
        item = R.submit(f"Reel: {j['title']}", j["video"],
                        notes=f"Caption: {j['caption']}\nMode: {j['mode']}\nHeaders: {json.dumps(j['headers'])}",
                        images=j["screens"], meta={"job": j["id"]})
        j["review_id"] = item["id"]; j["status"] = "waiting_review"; j["stage"] = "review"; _save()
        while True:
            it = R.get(item["id"])
            if j["status"] == "cancelled":
                return
            if not it or it["status"] != "pending":
                break
            time.sleep(4)
        if not it or it["status"] != "approved":
            j["status"] = "changes_requested"; j["feedback"] = (it or {}).get("feedback", "")
            _log(j, f"review: {(it or {}).get('status')} — {j.get('feedback','')[:200]}"); return
        _log(j, "review: approved")
    if not j["post"]:
        j["status"] = "done"; j["stage"] = "composer_open"; _log(j, "left in the Instagram composer (post=false)"); return
    if j["not_before"]:
        j["status"] = "waiting_time"; j["stage"] = "waiting"; _save()
        while time.time() < float(j["not_before"]):
            if j["status"] == "cancelled":
                return
            time.sleep(5)
    j["status"] = "sharing"; j["stage"] = "share"; _save()
    _share(j)


def _resume(j):
    """Continue a job whose reel is already parked in the Instagram composer."""
    from . import review as R
    if j.get("review_id"):
        j["status"] = "waiting_review"; _save()
        while True:
            it = R.get(j["review_id"])
            if j["status"] == "cancelled":
                return
            if not it or it["status"] != "pending":
                break
            time.sleep(4)
        if not it or it["status"] != "approved":
            j["status"] = "changes_requested"; j["feedback"] = (it or {}).get("feedback", "")
            _log(j, f"review: {(it or {}).get('status')} — {j.get('feedback','')[:200]}"); return
        _log(j, "review: approved")
    if j["not_before"]:
        j["status"] = "waiting_time"; _save()
        while time.time() < float(j["not_before"]):
            if j["status"] == "cancelled":
                return
            time.sleep(5)
    j["status"] = "sharing"; j["stage"] = "share"; _save()
    _share(j)


def _share(j):
    ph = _ugc()
    if not ph.find("New reel"):
        raise RuntimeError("Instagram composer is not open; cannot share")
    ph.swipe(195, 650, 195, 150, ms=700); time.sleep(2)
    if j["mode"] == "trial":
        def trial():
            return [n for n in ph.elements() if n.get("type") == "Switch" and "Trial" in str(n.get("label"))]
        tr = trial()
        if tr and tr[0]["label"].startswith("Not checked"):
            r = tr[0]["rect"]
            sw = [n for n in ph.elements() if n.get("type") == "Switch" and not n.get("label") and abs(n["rect"]["y"] - r["y"]) < 30]
            if sw:
                s = sw[0]["rect"]; ph.tap(s["x"] + s["width"] / 2, s["y"] + s["height"] / 2); time.sleep(2)
        tr = trial()
        if not (tr and tr[0]["label"].startswith("Checked")):
            raise RuntimeError("could not turn on the Trial switch")
    acct = [n["label"] for n in ph.elements() if "Also share on" in str(n.get("label"))]
    _log(j, f"account: {acct[0] if acct else '?'}")
    s = ph.find("Share", exact=True, kind="Button")
    ph.tap(s["x"], s["y"]); time.sleep(8)
    labs = [n["label"] for n in ph.elements() if n.get("type") in ("Button", "StaticText") and n.get("label")]
    prog = [l for l in labs if "Step" in l or "Upload" in l or "Sharing" in l]
    j["shared_at"] = time.time(); j["status"] = "done"; j["stage"] = "shared"
    _log(j, f"shared ({j['mode']}) {prog[:1]}")
    with open(POSTS_FILE, "a") as f:
        f.write(f"{j['title']} {j['mode']} {time.strftime('%Y-%m-%d %H:%M:%S')}\n")


_load()
if any(j["status"] in ("queued", "resume") for j in _jobs):
    _ensure_worker()
