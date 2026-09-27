#!/usr/bin/env python3
"""Create and place a header text element in Instagram Edits.

Positioning is deterministic: a new element appears at the canvas centre, so we drag
by the known offset and only use pixel measurement (strict colours, narrow window) to
verify. Scanning the whole preview for "white" broke on bright footage (a lamp or a grey
hoodie reads as text) and dragged elements off the canvas.
"""
import subprocess
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import phone  # noqa: E402

PREVIEW_Y0, PREVIEW_H = 107, 332        # video frame inside the Edits text editor (points), measured from the accessibility tree
RECT_DRAG_GAIN = 0.825                  # element moves 0.825 pt per pt of drag
NAME_FRAC = 0.3025                      # reference: white career/subject line
IQ_FRAC = 0.385                         # gold second line
DRAG_GAIN = 0.65                        # canvas drags undershoot
CENTER_FRAC = 0.5                       # where Edits puts a new text element
SCALE = 3                               # screenshot px per point


def frac_to_preview(frac):
    return PREVIEW_Y0 + frac * PREVIEW_H


def _rows(png, y0_pt, y1_pt, gold):
    """Rows (in points) inside [y0_pt, y1_pt] that contain a run of text-coloured pixels."""
    y0 = int(y0_pt * SCALE); h = int((y1_pt - y0_pt) * SCALE)
    out = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", png, "-vf", f"crop=1170:{h}:0:{y0},format=rgb24",
                          "-f", "rawvideo", "-"], capture_output=True).stdout
    W = 1170
    hits = []
    for r in range(h):
        base = r * W * 3; n = 0
        for c in range(200, 970, 2):            # centre 2/3 of the canvas, every other pixel
            i = base + c * 3
            R, G, B = out[i], out[i + 1], out[i + 2]
            if gold:
                ok = R > 235 and G > 185 and B < 90 and G < R
            else:
                ok = R > 242 and G > 242 and B > 242 and abs(R - B) < 10
            if ok:
                n += 1
        if n > 25:
            hits.append(y0_pt + r / SCALE)
    return hits


def measure_near(y_pt, gold=False, window=45):
    """Centre (points) of the text band near y_pt, or None."""
    phone.shot("/tmp/_m.png")
    rows = _rows("/tmp/_m.png", max(PREVIEW_Y0, y_pt - window), min(PREVIEW_Y0 + PREVIEW_H, y_pt + window), gold)
    if len(rows) < 3:
        return None
    return (rows[0] + rows[-1]) / 2


def measure(gold=False):
    """Topmost text band anywhere in the preview (strict colours)."""
    phone.shot("/tmp/_m.png")
    rows = _rows("/tmp/_m.png", PREVIEW_Y0, PREVIEW_Y0 + PREVIEW_H, gold)
    if len(rows) < 3:
        return None, None
    return (rows[0] + rows[-1]) / 2, (rows[-1] - rows[0]) * SCALE


def set_size(target=34, tries=4):
    for _ in range(tries):
        e = phone.find("Resize text")
        if not e:
            return None
        v = int(e["value"])
        if abs(v - target) <= 2:
            return v
        r = e["rect"]
        ymid = r["y"] + r["height"] / 2
        phone.drag(5, ymid, 5, ymid + (v - target) * 3.0, ms=800, hold=500)
        time.sleep(1.5)
    e = phone.find("Resize text")
    return int(e["value"]) if e else None


def set_position(frac, gold=False, start_frac=CENTER_FRAC, tries=3, tol=3):
    """Move the SELECTED element from start_frac (default: canvas centre, where new
    elements appear) to frac. Every drag starts ON the element's believed position."""
    target = frac_to_preview(frac)
    cur = frac_to_preview(start_frac)
    seen = measure_near(cur, gold)
    if seen is not None:
        cur = seen
    for _ in range(tries):
        if abs(cur - target) <= tol:
            return cur
        phone.drag(195, cur, 195, cur + (target - cur) / DRAG_GAIN, ms=900, hold=500)
        time.sleep(1.8)
        seen = measure_near(target, gold)
        if seen is None:
            seen = measure_near(cur + (target - cur), gold, window=70)
        cur = seen if seen is not None else target
    return cur


def deselect():
    b = phone.find("back-button")
    if b:
        phone.tap(b["x"], b["y"])
        time.sleep(1.8)


# ---------------------------------------------------------------- rect-based placement
def element_rect(text):
    """Screen rect of the canvas text element (editor open). Edits exposes it as a
    TextView labelled 'Text on your story' with the text as value (or, in a broken
    project, label == text with zero width)."""
    for n in phone.elements():
        r = n.get("rect") or {}
        if (n.get("type") == "TextView" and (n.get("value") == text or n.get("label") == text)
                and r.get("width", 0) > 10 and r.get("height", 0) > 10       # Edits also exposes zero-size ghost nodes
                and 0 <= r.get("y", -1) < 470):
            return {k: float(r[k]) for k in ("x", "y", "width", "height")}
    return None


def element_center_y(text):
    r = element_rect(text)
    return None if r is None else r["y"] + r["height"] / 2


def on_canvas(text):
    c = element_center_y(text)
    return c is not None and PREVIEW_Y0 + 8 <= c <= PREVIEW_Y0 + PREVIEW_H - 8


def place(text, frac, tries=9, tol=3.0):
    """Move the selected element so its centre sits at frac of the frame. A drag can
    drop the element's selection, after which further drags do nothing — so every step
    is small, verified against the rect, and a stall re-taps the element first."""
    target = frac_to_preview(frac)
    stall = 0
    for _ in range(tries):
        cur = element_center_y(text)
        if cur is None:
            return None
        dy = target - cur
        if abs(dy) <= tol:
            return cur
        step = max(-50.0, min(50.0, dy / RECT_DRAG_GAIN))
        phone.drag(195, cur, 195, cur + step, ms=900, hold=500)
        time.sleep(1.5)
        new = element_center_y(text)
        if new is None:
            return None
        if abs(new - cur) < 2:
            stall += 1
            phone.tap(195, new); time.sleep(1.2)      # re-select, then try again
            if stall >= 3:
                return new
        else:
            stall = 0
    return element_center_y(text)
