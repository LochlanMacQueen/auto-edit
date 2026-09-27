#!/usr/bin/env python3
"""Timeline helpers for Instagram Edits that never assume a track's y.

Track y MOVES: the header track is y=563 normally, 583 with the context
toolbar showing, and extra overlay tracks appear at 543 and above. Every helper
here re-reads the tracks each call.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone  # noqa: E402

PLAYHEAD_X = 195.0
PT_PER_SEC = 72.7
MIN_DRAG = 20            # drags under ~15pt do not register
EDGE_MAX = 330           # keep grab points away from the screen edge

TOOLBAR = {"Split", "Edit", "Copy", "Delete", "Duplicate", "Opacity", "Text to speech",
           "Add to project", "Undo", "Redo", "Hide", "Mute", "Audio", "Text", "Voice",
           "Links", "Captions", "Filters", "Play"}


class AppLeft(RuntimeError):
    """Edits is no longer in front — e.g. a system banner took a tap and opened Settings."""


EDITS_BUNDLE = "com.burbn.basel"


def front_app():
    try:
        return json.loads(phone._curl("/wda/activeAppInfo")).get("value", {}).get("bundleId")
    except Exception:
        return None


def rows():
    front = front_app()
    if front and front != EDITS_BUNDLE:
        raise AppLeft(f"{front} is in front, not Instagram Edits")
    out = []
    for n in phone.elements():
        lbl = str(n.get("label") or "")
        r = n.get("rect") or {}
        if not r.get("width") or not (30 <= r.get("height", 0) <= 42):
            continue
        if not lbl or lbl in TOOLBAR or lbl.startswith("timed") or lbl.startswith("00:"):
            continue
        if not (470 < r.get("y", 0) < 720):      # top overlay tracks can sit as high as ~478
            continue
        out.append({"y": r["y"], "x": r["x"], "w": r["width"], "h": r["height"], "label": lbl})
    return out


def tracks():
    t = {}
    for r in rows():
        t.setdefault(r["y"], []).append(r)
    return dict(sorted(t.items()))


def caption_y():
    t = tracks()
    return max(t, key=lambda y: sum(len(r["label"]) for r in t[y])) if t else None


def scroll_row():
    """A row that actually scrolls the timeline. The caption row (bottom-most,
    against the video strip) does NOT respond to horizontal swipes; the overlay
    rows above it do. Prefer the lowest non-caption track."""
    t = tracks(); cy = caption_y()
    ys = [y for y in t if y != cy]
    return max(ys) if ys else (cy if cy is not None else 620)


def pill(sub, on_caption_track=None):
    cy = caption_y()
    for r in rows():
        if sub.lower() not in r["label"].lower():
            continue
        if on_caption_track is True and r["y"] != cy:
            continue
        if on_caption_track is False and r["y"] == cy:
            continue
        return r
    return None


def caption(sub):
    return pill(sub, on_caption_track=True)


def page(direction, ms=550):
    """direction -1 = toward the start, +1 = toward the end."""
    y = scroll_row()
    if direction < 0:
        phone.swipe(80, y, 340, y, ms=ms)
    else:
        phone.swipe(340, y, 80, y, ms=ms)
    time.sleep(1.25)


def to_start(times=18):
    for _ in range(times):
        page(-1, ms=430)
    time.sleep(1.0)


def bring_into_view(sub, tries=26):
    """Scroll until the pill is inside the viewport and tappable."""
    for _ in range(tries):
        p = pill(sub)
        if p and 20 <= p["x"] <= 320:
            return p
        if p is None:
            page(+1)          # we start from the beginning, so unseen pills are to the right
            continue
        d = p["x"] - 170
        step = max(-250, min(250, d))
        y = scroll_row()
        phone.drag(200, y, 200 - step, y, ms=900, hold=350)
        time.sleep(1.3)
    p = pill(sub)
    return p if (p and 0 <= p["x"] <= 380) else None


def deselect():
    b = phone.find("back-button")
    if b:
        phone.tap(b["x"], b["y"])
        time.sleep(1.8)


def delete_pill(sub):
    p = bring_into_view(sub)
    if not p:
        return False
    phone.tap(p["x"] + min(18, max(4, p["w"] / 2)), p["y"] + p["h"] / 2)
    time.sleep(2.0)
    d = phone.find("Delete")
    if not d:
        deselect()
        return False
    phone.tap(d["x"], d["y"])
    time.sleep(2.5)
    return pill(sub) is None


def scroll_to_caption(sub, tries=16, tol=10):
    """Put a caption's left edge under the playhead."""
    for _ in range(tries):
        c = caption(sub)
        if c is None:
            page(+1)
            continue
        d = c["x"] - PLAYHEAD_X
        if abs(d) <= tol:
            return c
        y = scroll_row()
        phone.drag(250, y, 250 - d, y, ms=1100, hold=350)
        time.sleep(1.3)
    return caption(sub)


def extend_to_caption(pill_sub, cap_sub, rounds=26):
    """Drag a pill's right edge until it meets a caption's start."""
    stalls = 0
    for _ in range(rounds):
        p, c = pill(pill_sub), caption(cap_sub)
        if p is None:
            page(-1)
            continue
        right = p["x"] + p["w"]
        if c is not None and abs(right - c["x"]) <= 12:
            return True
        if p["x"] < 10 or right > EDGE_MAX or c is None or (min(c["x"], EDGE_MAX) - right) < MIN_DRAG:
            y = scroll_row()
            phone.drag(300, y, 150, y, ms=900, hold=350)
            time.sleep(1.3)
            continue
        phone.drag(right - 2, p["y"] + p["h"] / 2, min(c["x"], EDGE_MAX), p["y"] + p["h"] / 2,
                   ms=900, hold=700)
        time.sleep(1.4)
        q = pill(pill_sub)
        nw = q["w"] if q else -1
        stalls = stalls + 1 if abs(nw - p["w"]) < 3 else 0
        if stalls >= 4:
            return False
    return False


def map_all(pages=14):
    """Scroll the whole timeline and return every pill with a global x."""
    to_start()
    off, acc = 0.0, {}
    prev = rows()
    for v in prev:
        acc.setdefault(v["label"], {"x": v["x"], "w": v["w"], "y": v["y"]})
    for _ in range(pages):
        page(+1)
        cur = rows()
        d = None
        for c in cur:
            for p in prev:
                if c["label"] == p["label"]:
                    d = p["x"] - c["x"]
                    break
            if d is not None:
                break
        if d is None:
            break
        off += d
        for v in cur:
            acc.setdefault(v["label"], {"x": v["x"] + off, "w": v["w"], "y": v["y"]})
        prev = cur
    return acc


def report():
    acc = map_all()
    caps = {k: v for k, v in acc.items() if len(k) > 30}
    if not caps:
        return []
    x0 = min(v["x"] for v in caps.values())
    cy = max({v["y"] for v in acc.values()},
             key=lambda y: sum(len(k) for k, v in acc.items() if v["y"] == y))
    out = []
    for k, v in sorted(acc.items(), key=lambda kv: (kv[1]["y"], kv[1]["x"])):
        out.append({"track": "CAP" if v["y"] == cy else "y%d" % v["y"], "label": k,
                    "start": (v["x"] - x0) / PT_PER_SEC,
                    "end": (v["x"] + v["w"] - x0) / PT_PER_SEC})
    return out


def extend_to_width(sub, target_w, rounds=30, tol=14):
    """Drag a pill's right edge until it reaches target_w points.

    Targeting a width rather than a caption avoids needing both the pill and
    the destination caption on screen at the same time.
    """
    stalls = 0
    for _ in range(rounds):
        p = pill(sub)
        if p is None:
            page(-1)
            continue
        if abs(p["w"] - target_w) <= tol:
            return True
        right = p["x"] + p["w"]
        # need the right edge on screen with room to drag
        if p["x"] < 5 or right > EDGE_MAX or (EDGE_MAX - right) < MIN_DRAG:
            y = scroll_row()
            phone.drag(300, y, 150, y, ms=900, hold=350)
            time.sleep(1.3)
            continue
        want = min(right + (target_w - p["w"]), EDGE_MAX)
        if want - right < MIN_DRAG:
            y = scroll_row()
            phone.drag(300, y, 150, y, ms=900, hold=350)
            time.sleep(1.3)
            continue
        phone.drag(right - 2, p["y"] + p["h"] / 2, want, p["y"] + p["h"] / 2, ms=900, hold=700)
        time.sleep(1.4)
        q = pill(sub)
        nw = q["w"] if q else -1
        stalls = stalls + 1 if abs(nw - p["w"]) < 3 else 0
        if stalls >= 5:
            return False
    return abs((pill(sub) or {"w": 0})["w"] - target_w) <= tol
