#!/usr/bin/env python3
"""WDA driver for the iPhone (Lochs-IOS-Agents phone farm).

Talks straight to WebDriverAgent on :8100. The dashboard's /api/... routes are
behind a CSRF guard, so automation uses WDA directly; the dashboard at
http://127.0.0.1:3000 stays available for watching the live stream.

CLI: phone.py tap X Y | swipe X1 Y1 X2 Y2 MS | shot OUT.png | home | app | source
Coordinates are in POINTS (iPhone 13 Pro is 390x844).

Hard-won rules, do not regress:
  * NEVER create a WDA session mid-edit. Creating one — even without a bundleId
    — throws the foreground app back to the home screen and loses editor state.
    That rules out /wda/keys, so text is typed by tapping the on-screen keyboard.
  * NEVER batch key presses into one absolute-actions call. A multi-point
    pointer sequence is read as swipe-typing (QuickPath) and yields a predicted
    word — "What your IQ is" came out as "Whaleboats". One tap per key, with a
    delay between them.
  * Read shift state from accessibility (the shift Button's value is '1' when
    engaged) rather than tracking it; iOS auto-capitalises the first character
    of a field and drops shift after each letter.
"""
import base64
import os
import json
import subprocess
import sys
import time

WDA = "http://127.0.0.1:8100"


# ---------------------------------------------------------------- transport
def _curl(path, method="GET", body=None, timeout=60):
    cmd = ["curl", "-s", "--max-time", str(timeout), "-X", method, f"{WDA}{path}"]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "--data-binary", json.dumps(body)]
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def _actions(actions):
    return _curl("/wda/absolute-actions", "POST", {"actions": [{
        "type": "pointer", "id": "finger1",
        "parameters": {"pointerType": "touch"}, "actions": actions}]})


# ---------------------------------------------------------------- primitives
def tap(x, y, hold=60):
    return _actions([
        {"type": "pointerMove", "duration": 0, "x": x, "y": y, "origin": "viewport"},
        {"type": "pointerDown", "button": 0},
        {"type": "pause", "duration": hold},
        {"type": "pointerUp", "button": 0}])


def swipe(x1, y1, x2, y2, ms=400):
    return _actions([
        {"type": "pointerMove", "duration": 0, "x": x1, "y": y1, "origin": "viewport"},
        {"type": "pointerDown", "button": 0},
        {"type": "pause", "duration": 60},
        {"type": "pointerMove", "duration": ms, "x": x2, "y": y2, "origin": "viewport"},
        {"type": "pointerUp", "button": 0}])


def drag(x1, y1, x2, y2, ms=900, hold=700):
    """Long-press then drag — for moving timeline pills and text elements."""
    return _actions([
        {"type": "pointerMove", "duration": 0, "x": x1, "y": y1, "origin": "viewport"},
        {"type": "pointerDown", "button": 0},
        {"type": "pause", "duration": hold},
        {"type": "pointerMove", "duration": ms, "x": x2, "y": y2, "origin": "viewport"},
        {"type": "pause", "duration": 200},
        {"type": "pointerUp", "button": 0}])


def shot(out="/tmp/p.png"):
    raw = _curl("/screenshot", timeout=90)
    open(out, "wb").write(base64.b64decode(json.loads(raw)["value"]))
    return out


def home():
    return _curl("/wda/homescreen", "POST", {})


def app():
    return _curl("/wda/activeAppInfo")


def source():
    return _curl("/source?format=json", timeout=120)


# ---------------------------------------------------------------- elements
def tree():
    return json.loads(source())["value"]


def _flat(node, out):
    out.append(node)
    for child in (node.get("children") or []):
        _flat(child, out)
    return out


def elements():
    return _flat(tree(), [])


def find(label=None, exact=False, kind=None, nth=0, nodes=None):
    """Find an element by accessibility label/name (substring unless exact)."""
    hits = []
    for n in (nodes or elements()):
        if kind and n.get("type") != kind:
            continue
        lbl = str(n.get("label") or n.get("name") or "")
        if label is not None:
            if exact and lbl != label:
                continue
            if not exact and label.lower() not in lbl.lower():
                continue
        rect = n.get("rect") or {}
        if not rect.get("width"):
            continue
        hits.append({"label": lbl, "value": str(n.get("value") or ""), "type": n.get("type"),
                     "x": rect["x"] + rect["width"] / 2, "y": rect["y"] + rect["height"] / 2,
                     "rect": rect})
    return hits[nth] if len(hits) > nth else None


def tap_label(label, exact=False, kind=None, nth=0, settle=1.5):
    e = find(label, exact=exact, kind=kind, nth=nth)
    if not e:
        raise RuntimeError(f"element not found: {label!r}")
    tap(e["x"], e["y"])
    time.sleep(settle)
    return e


# ---------------------------------------------------------------- keyboard
def keyboard_map(nodes=None):
    """Every key on the on-screen keyboard.

    Letters are type 'Key'; shift and return are 'Button'; the space bar has an
    empty label. Keys are 44-80pt tall and sit below y=540, which excludes the
    timeline pills (37pt) and the track Hide/Mute buttons (21pt).
    """
    keys = {}
    for n in (nodes or elements()):
        if n.get("type") not in ("Key", "Button"):
            continue
        r = n.get("rect") or {}
        h = r.get("height", 0)
        if not r.get("width") or r.get("y", 0) < 540 or not (44 <= h <= 80):
            continue
        label = str(n.get("label") or n.get("name") or "").strip()
        if not label and r["width"] > 150:
            label = "space"
        if label:
            # Letter keys are labelled uppercase while shift is engaged and
            # lowercase otherwise, but their positions never move — store them
            # case-normalised so lookups work in either state.
            if len(label) == 1 and label.isalpha():
                label = label.lower()
            keys.setdefault(label, (r["x"] + r["width"] / 2, r["y"] + r["height"] / 2))
    return keys


def shift_on(nodes=None):
    for n in (nodes or elements()):
        if str(n.get("label") or n.get("name") or "") == "shift":
            return str(n.get("value") or "") == "1"
    return False


def text_value(nodes=None):
    for n in (nodes or elements()):
        if n.get("type") == "TextView":
            return n.get("value")
    return None


def clear_text(kb=None, n=60):
    kb = kb or keyboard_map()
    delete = kb["delete"]
    for _ in range(n):
        tap(*delete)
        time.sleep(0.07)


def type_taps(text, kb=None, delay=0.14):
    """Type by tapping one key at a time, handling shift and layout switches."""
    kb = kb or keyboard_map()
    layout, typed, missing = "letters", 0, []
    for ch in text:
        if ch.isalpha():
            if layout != "letters":
                sw = kb.get("letters") or kb.get("ABC")
                if sw:
                    tap(*sw); time.sleep(0.6); kb = keyboard_map(); layout = "letters"
            want = ch.isupper()
            if shift_on() != want and "shift" in kb:
                tap(*kb["shift"]); time.sleep(0.35)
                if shift_on() != want:                      # one retry
                    tap(*kb["shift"]); time.sleep(0.35)
            pt = kb.get(ch.lower())
            if pt is None:
                missing.append(ch); continue
            tap(*pt); time.sleep(delay); typed += 1
            continue

        name = {" ": "space", "\n": "return"}.get(ch, ch)
        pt = kb.get(name) or kb.get(ch)
        if pt is None:                                      # try the other layout
            sw = kb.get("numbers") if layout == "letters" else (kb.get("letters") or kb.get("ABC"))
            if sw:
                tap(*sw); time.sleep(0.6); kb = keyboard_map()
                layout = "numbers" if layout == "letters" else "letters"
                pt = kb.get(name) or kb.get(ch)
        if pt is None:
            missing.append(ch); continue
        tap(*pt); time.sleep(delay); typed += 1
    return typed, missing


def type_verified(text, kb=None, attempts=3):
    """Type `text` and confirm it landed, clearing and retrying on mismatch."""
    kb = kb or keyboard_map()
    for _ in range(attempts):
        typed, missing = type_taps(text, kb=kb)
        time.sleep(0.8)
        got = text_value()
        if got == text:
            return True, got
        clear_text(kb=kb, n=len(str(got or "")) + 8)
        time.sleep(0.5)
    return False, text_value()


if __name__ == "__main__":
    c = sys.argv[1]
    if c == "tap":
        print(tap(float(sys.argv[2]), float(sys.argv[3])))
    elif c == "swipe":
        print(swipe(*[float(a) for a in sys.argv[2:6]],
                    ms=int(sys.argv[6]) if len(sys.argv) > 6 else 400))
    elif c == "shot":
        print(shot(sys.argv[2] if len(sys.argv) > 2 else "/tmp/p.png"))
    elif c == "home":
        print(home())
    elif c == "app":
        print(app())
    elif c == "source":
        print(source())


# ---------------------------------------------------------------- timeline
def pill(substring, track=None):
    """A timeline pill (text/caption/audio) by its label substring."""
    for n in elements():
        label = str(n.get("label") or n.get("name") or "")
        r = n.get("rect") or {}
        if substring not in label:
            continue
        if not r.get("width") or r.get("y", 0) < 540 or r.get("height", 0) >= 45:
            continue
        if track is not None and abs(r["y"] - track) > 8:
            continue
        return r
    return None


def pills(prefix="timed-element-pill"):
    out = []
    for n in elements():
        label = str(n.get("label") or n.get("name") or "")
        r = n.get("rect") or {}
        if label.startswith(prefix) and r.get("width"):
            out.append({"label": label, **r})
    return sorted(out, key=lambda p: (p["y"], p["x"]))


def set_pill_end(substring, target_x, tries=8, tol=3):
    """Drag a pill's right edge until it lands on target_x. Edge drags under-
    shoot (the grip has resistance), so iterate and re-measure each time."""
    for _ in range(tries):
        r = pill(substring)
        if not r:
            return None
        right = r["x"] + r["width"]
        if abs(right - target_x) <= tol:
            return r
        y = r["y"] + r["height"] / 2
        # aim past the target to compensate for the undershoot
        over = target_x + (target_x - right) * 1.6
        drag(right - 3, y, over, y, ms=800, hold=600)
        time.sleep(1.2)
    return pill(substring)


def set_pill_start(substring, target_x, tries=8, tol=3):
    for _ in range(tries):
        r = pill(substring)
        if not r:
            return None
        if abs(r["x"] - target_x) <= tol:
            return r
        y = r["y"] + r["height"] / 2
        over = target_x + (target_x - r["x"]) * 1.6
        drag(r["x"] + 3, y, over, y, ms=800, hold=600)
        time.sleep(1.2)
    return pill(substring)


def wait_keyboard(timeout=15):
    """Block until the on-screen keyboard is up; return its key map."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        kb = keyboard_map()
        if len(kb) > 20 and "delete" in kb:
            return kb
        time.sleep(1.0)
    raise RuntimeError("keyboard did not appear")


# ---------------------------------------------------------------- session (create ONCE, before opening the app)
SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".wda_session")


def start_session(bundle=None, timeout_s=3600):
    """Create the WDA session up front. Creating one mid-edit throws the app to
    the home screen, so call this before launching Edits; with it, typing is a
    single /wda/keys call and element lookups are predicate queries."""
    caps = {"platformName": "iOS", "shouldWaitForQuiescence": False, "newCommandTimeout": timeout_s}
    if bundle:
        caps["bundleId"] = bundle
    r = json.loads(_curl("/session", "POST", {"capabilities": {"alwaysMatch": caps}}, timeout=120))
    sid = r["sessionId"]
    open(SESSION_FILE, "w").write(sid)
    return sid


def session():
    try:
        sid = open(SESSION_FILE).read().strip()
    except FileNotFoundError:
        return None
    r = _curl(f"/session/{sid}")
    return None if '"error"' in (r or "") else sid


def type_fast(text):
    """Whole string in one call. Requires a live session made by start_session()."""
    sid = session()
    if not sid:
        raise RuntimeError("no live WDA session — call start_session() before opening the app")
    return _curl(f"/session/{sid}/wda/keys", "POST", {"value": list(text)}, timeout=90)


def find_fast(label, partial=True):
    """Predicate element lookup via the session; returns centre point or None."""
    sid = session()
    if not sid:
        return None
    op = "CONTAINS[c]" if partial else "=="
    r = json.loads(_curl(f"/session/{sid}/element", "POST",
                         {"using": "predicate string", "value": f"label {op} '{label}'"}))
    el = (r.get("value") or {})
    eid = el.get("ELEMENT") or el.get("element-6066-11e4-a52e-4f735466cecf")
    if not eid:
        return None
    rect = json.loads(_curl(f"/session/{sid}/element/{eid}/rect")).get("value") or {}
    if not rect.get("width"):
        return None
    return rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2


def launch(bundle):
    sid = session()
    if sid:
        return _curl(f"/session/{sid}/wda/apps/launch", "POST", {"bundleId": bundle})
    return None
