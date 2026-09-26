"""Review queue: finished videos wait here for the person to approve or send back
notes. The dashboard renders it; the agent submits and polls."""
import json
import threading
import time
import uuid

from .config import HOME

FILE = HOME / "review" / "items.json"
_lock = threading.Lock()


def _load():
    try:
        return json.loads(FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save(items):
    FILE.write_text(json.dumps(items, indent=1))


def submit(title, video, notes="", images=None, meta=None) -> dict:
    item = {"id": uuid.uuid4().hex[:8], "title": title, "video": str(video), "notes": notes,
            "images": [str(i) for i in (images or [])], "meta": meta or {},
            "status": "pending", "feedback": "", "created": time.time(), "decided": None}
    with _lock:
        items = _load(); items.insert(0, item); _save(items)
    return item


def get(item_id) -> dict | None:
    return next((i for i in _load() if i["id"] == item_id), None)


def all_items() -> list:
    return _load()


def decide(item_id, status, feedback="") -> dict | None:
    with _lock:
        items = _load()
        for i in items:
            if i["id"] == item_id:
                i["status"] = status; i["feedback"] = feedback; i["decided"] = time.time()
                _save(items)
                return i
    return None


def wait(item_id, timeout_s=600, poll=3) -> dict | None:
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        i = get(item_id)
        if not i or i["status"] != "pending":
            return i
        time.sleep(poll)
    return get(item_id)


def remove(item_id):
    with _lock:
        _save([i for i in _load() if i["id"] != item_id])
