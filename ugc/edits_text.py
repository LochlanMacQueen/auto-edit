#!/usr/bin/env python3
"""Create and place a header text element in Instagram Edits.

A new text element spans from the playhead to the end of the video, so the
caller positions the playhead first (see edits_headers.scroll_to_caption).
"""
import subprocess
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone  # noqa: E402

PREVIEW_Y0, PREVIEW_H = 112, 332        # video frame inside the Edits canvas
NAME_FRAC = 0.3025                      # reference: white career/subject line
IQ_FRAC = 0.385                         # lowered from the reference 0.3512 so two-line names never collide
DRAG_GAIN = 0.65                        # canvas drags undershoot


def frac_to_preview(frac):
    return PREVIEW_Y0 + frac * PREVIEW_H


def _bands(png, y0=300, h=1100, gold=False, thresh=40):
    """Rows of white (or gold) text inside the canvas, in screenshot pixels."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", png,
                          "-vf", f"crop=1170:{h}:0:{y0},format=rgb24",
                          "-f", "rawvideo", "-"], capture_output=True).stdout
    W = 1170
    def hit(r, c):
        i = (r * W + c) * 3
        R, G, B = out[i], out[i+1], out[i+2]
        return (R > 190 and G > 150 and B < 110) if gold else (R > 235 and G > 235 and B > 235)
    rows = [sum(1 for c in range(W) if hit(r, c)) for r in range(h)]
    runs, cur = [], None
    for r, v in enumerate(rows):
        if v > thresh and cur is None:
            cur = r
        elif v <= thresh and cur is not None:
            if r - cur > 8:
                runs.append((cur + y0, r + y0))
            cur = None
    return runs


def measure(gold=False):
    """(centre_pt, cap_px) of the topmost text band on the canvas."""
    phone.shot("/tmp/_m.png")
    runs = [r for r in _bands("/tmp/_m.png", gold=gold) if r[0] < 900]
    if not runs:
        return None, None
    a, b = runs[0]
    return (a + b) / 2 / 3, b - a


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


def set_position(frac, gold=False, tries=6, tol=2):
    target = frac_to_preview(frac)
    for _ in range(tries):
        cur, _cap = measure(gold=gold)
        if cur is None:
            return None
        if abs(cur - target) <= tol:
            return cur
        phone.drag(195, cur, 195, cur + (target - cur) / DRAG_GAIN, ms=900, hold=500)
        time.sleep(1.8)
    cur, _ = measure(gold=gold)
    return cur


def deselect():
    b = phone.find("back-button")
    if b:
        phone.tap(b["x"], b["y"])
        time.sleep(1.8)


def add_header(text, frac=NAME_FRAC, size=34, gold=False):
    """Create a text element at the playhead, style-inherited, then place it."""
    deselect()
    t = phone.find("Text", exact=True)
    if not t:
        raise RuntimeError("Text tool not found — is a pill still selected?")
    phone.tap(t["x"], t["y"])
    time.sleep(5)
    kb = phone.wait_keyboard(timeout=20)
    # Do NOT clear a fresh element: hammering delete on an empty field dismisses
    # the editor and discards the element.
    typed, missing = phone.type_taps(text, kb=kb)
    time.sleep(1.2)
    got = phone.text_value()
    if got != text:                       # one repair pass, now that it exists
        phone.clear_text(kb=kb, n=len(str(got or "")) + 6)
        time.sleep(0.8)
        phone.type_taps(text, kb=kb)
        time.sleep(1.2)
        got = phone.text_value()
    set_size(size)
    set_position(frac, gold=gold)
    d = phone.find("Done")
    if d:
        phone.tap(d["x"], d["y"])
        time.sleep(3)
    return got
