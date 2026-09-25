#!/usr/bin/env python3
"""Header recipe v2 for Instagram Edits (split-based, two tracks).

  name track : one white element created at 0, EXTENDED to the end of the
               video, then split at every section start and re-texted.
  gold track : same, but gold / smaller / lower, split at the same points,
               re-texted with the IQ range; the tail after the CTA is deleted.

Everything is found by geometry, never by hard-coded y: track rows move by
~20 pt whenever the context toolbar shows.  Text editing goes through the
context-toolbar "Edit" button (opens the text editor directly), not canvas
taps.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone  # noqa: E402
import edits_timeline as T  # noqa: E402
import edits_text as ET  # noqa: E402

EDGE_MAX = 330
GOLD = "Suggested color #FFD400"


def log(*a):
    print(" ".join(str(x) for x in a), flush=True)


# ------------------------------------------------------------- geometry
def header_rows():
    """Non-caption track ys, lowest first (name track is created first)."""
    cy = T.caption_y()
    return sorted({r["y"] for r in T.rows() if r["y"] != cy}, reverse=True)


def pills_on(y):
    return sorted([r for r in T.rows() if abs(r["y"] - y) < 6], key=lambda r: r["x"])


def under_playhead(y):
    for r in pills_on(y):
        if r["x"] <= T.PLAYHEAD_X < r["x"] + r["w"]:
            return r
    return None


def free_point():
    """A (x, y) on a track row with no pill under it, for scrolling."""
    cy = T.caption_y()
    rows = T.rows()
    ys = sorted({r["y"] for r in rows if r["y"] != cy})
    if cy is not None:
        ys = ys + [cy - 40] if (cy - 40) not in ys else ys
    for y in ys:
        for x in (300, 250, 340, 200, 120, 60):
            if not any(abs(r["y"] - y) < 6 and r["x"] <= x <= r["x"] + r["w"] for r in rows):
                return x, y
    return 300, (ys[0] - 40 if ys else 560)


def scroll(dx):
    """Move timeline content by dx points (negative = later content comes in)."""
    x, y = free_point()
    x0 = min(max(x, 40), 340)
    phone.drag(x0, y, x0 + dx, y, ms=900, hold=350)
    time.sleep(1.3)


def select(p):
    x = min(max(p["x"] + min(p["w"] / 2, 25), 12), 370)
    phone.tap(x, p["y"] + p["h"] / 2)
    time.sleep(1.8)


def tool(name):
    for _ in range(4):
        b = phone.find(name, exact=True, kind="Button")
        if b and 730 < b["y"] < 790:
            return b
        phone.swipe(360, 752, 80, 752, ms=500); time.sleep(1.0)
    return None


# --------------------------------------------------------------- typing
def editor_value():
    """The text editor's own field (bottom panel). The canvas text elements are
    TextViews too, so phone.text_value() must not be used here."""
    for n in phone.elements():
        r = n.get("rect") or {}
        if n.get("type") == "TextView" and r.get("y", 0) > 440 and not n.get("label"):
            return n.get("value")
    return None


def type_into_editor(text, current=""):
    kb = phone.wait_keyboard(timeout=15)
    if current:
        phone.clear_text(kb=kb, n=len(current) + 8); time.sleep(0.6)
    for _ in range(2):
        phone.type_taps(text, kb=kb); time.sleep(1.0)
        got = editor_value()
        if got == text:
            return True
        log("  typo:", repr(got), "-> retry")
        if not got:                     # never hammer delete on an empty field: it discards the element
            continue
        phone.clear_text(kb=kb, n=len(str(got or "")) + 8); time.sleep(0.6)
    return False


def done():
    """Close the text editor with the top-bar Done (never a keyboard key called
    Done) and make sure it actually closed: a tap that lands while the editor
    is still open types garbage into the header."""
    for _ in range(3):
        ds = [n for n in phone.elements() if n.get("label") == "Done" and n.get("type") == "Button"
              and (n.get("rect") or {}).get("y", 999) < 100]
        if not ds:
            break
        r = ds[0]["rect"]; phone.tap(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); time.sleep(3)
    T.deselect()


def make_gold():
    f = phone.find("Text font selector button"); phone.tap(f["x"], f["y"]); time.sleep(2.5)
    phone.tap(195, 436); time.sleep(3)
    g = phone.find(GOLD)
    if g:
        phone.tap(g["x"], g["y"]); time.sleep(2.5)


def style_classic_outline():
    """Font = Classic, Outline on. Called inside the text editor."""
    f = phone.find("Text font selector button"); phone.tap(f["x"], f["y"]); time.sleep(2.5)
    phone.tap(140, 436); time.sleep(2.5)                       # Font tab
    c = phone.find("Classic", exact=True, kind="Button")
    if c:
        phone.tap(c["x"], c["y"]); time.sleep(2.0)
    phone.tap(358, 436); time.sleep(2.5)                       # Outline tab
    o = [n for n in phone.elements() if n.get("label") == "Outline" and n.get("type") == "Other"]
    if o:
        r = o[0]["rect"]; phone.tap(r["x"] + r["width"] / 2, r["y"] + 40); time.sleep(2.0)
    a = phone.find("Apply to track")
    if a and str(a.get("value")) == "1":                       # keep per-element; the toggle is sticky
        phone.tap(a["x"], a["y"]); time.sleep(1.0)


def restyle(p, gold=False, frac=None):
    select(p)
    e = tool("Edit")
    if not e:
        T.deselect(); return False
    phone.tap(e["x"], e["y"]); time.sleep(3)
    style_classic_outline()
    if frac is not None:
        ET.set_position(frac, gold=gold)
    done()
    return True


def create_at_start(text, size, frac, gold=False):
    T.deselect(); T.to_start()
    t = phone.find("Text", exact=True); phone.tap(t["x"], t["y"]); time.sleep(4)
    type_into_editor(text)
    if gold:
        make_gold()
    style_classic_outline()
    ET.set_size(size); ET.set_position(frac, gold=gold)
    done()
    rows = header_rows()
    y = rows[-1] if gold else rows[-1]           # newest track is the highest = last
    y = min(header_rows())
    p = [r for r in pills_on(y) if r["label"] == text]
    log("created", repr(text), "row", y, "ok" if p else "!! not found")
    return y


def extend_to_end(y, label):
    """Drag the right handle of the pill on row y until it stops growing."""
    stalls = 0
    for _ in range(40):
        p = [r for r in pills_on(y) if r["label"] == label]
        if not p:
            scroll(+200); continue
        p = p[0]; right = p["x"] + p["w"]
        if right > EDGE_MAX - T.MIN_DRAG:
            scroll(-(right - 110)); continue
        if p["x"] < 5:
            pass
        select(p)
        p = [r for r in pills_on(y) if r["label"] == label] or [p]
        p = p[0]; right = p["x"] + p["w"]; ym = p["y"] + p["h"] / 2
        phone.drag(right - 2, ym, EDGE_MAX, ym, ms=900, hold=700); time.sleep(1.4)
        q = [r for r in pills_on(y) if r["label"] == label]
        nw = q[0]["w"] if q else -1
        T.deselect()
        if nw - p["w"] < 3:
            stalls += 1
            if stalls >= 2:
                log("  extended", repr(label), "w=%d" % nw)
                return True
        else:
            stalls = 0
    return False


PT_PER_SEC = 65.1          # calibrated on career1 (31.0 s caption at 2017 pt)


def set_width(y, label, target_w, tol=12):
    """Drag the right handle of the pill on row y until its width is target_w.
    Overshooting the video end EXTENDS THE PROJECT (black tail), so never drag
    blindly to the end."""
    stalls = 0
    for _ in range(90):
        p = [r for r in pills_on(y) if r["label"] == label]
        if not p:
            scroll(+200); continue
        p = p[0]; right = p["x"] + p["w"]; need = target_w - p["w"]
        if abs(need) <= tol:
            log("  width", repr(label), "=", round(p["w"]), "target", round(target_w))
            return True
        if need > 0 and right > EDGE_MAX - T.MIN_DRAG:
            scroll(-(right - 110)); continue
        if need < 0 and (right > EDGE_MAX or right < 40 + T.MIN_DRAG):
            scroll(-(right - 320)); continue
        select(p)
        p = ([r for r in pills_on(y) if r["label"] == label] or [p])[0]
        right = p["x"] + p["w"]; ym = p["y"] + p["h"] / 2
        dest = min(EDGE_MAX, right + need) if need > 0 else max(40, right + need)
        if abs(dest - right) < T.MIN_DRAG:
            dest = right + (T.MIN_DRAG if need > 0 else -T.MIN_DRAG)
        phone.drag(right - 2, ym, dest, ym, ms=900, hold=700); time.sleep(1.4)
        q = [r for r in pills_on(y) if r["label"] == label]
        nw = q[0]["w"] if q else -1
        T.deselect()
        if abs(nw - p["w"]) < 3:
            stalls += 1
            if stalls >= 3:
                log("  !! width stalled", repr(label), nw); return False
        else:
            stalls = 0
    return False


def split_at_playhead(y):
    p = under_playhead(y)
    if not p or T.PLAYHEAD_X - p["x"] < 6:
        return None
    select(p)
    s = tool("Split")
    if not s:
        T.deselect(); return None
    phone.tap(s["x"], s["y"]); time.sleep(2.5)
    T.deselect()
    right = [r for r in pills_on(y) if abs(r["x"] - T.PLAYHEAD_X) < 8]
    return right[0] if right else None


def retext(p, text):
    select(p)
    e = tool("Edit")
    if not e:
        T.deselect(); return False
    phone.tap(e["x"], e["y"]); time.sleep(3)
    ok = type_into_editor(text, current=p["label"])
    done()
    return ok


def delete(p):
    select(p)
    d = tool("Delete")
    if d:
        phone.tap(d["x"], d["y"]); time.sleep(2.5)
    T.deselect()


def clear_headers():
    """Delete every non-caption pill visible at the start (repeat until none)."""
    T.deselect(); T.to_start()
    for _ in range(12):
        cy = T.caption_y()
        hp = [r for r in T.rows() if r["y"] != cy and -5 < r["x"] < 370]
        if not hp:
            return
        delete(hp[0])


# --------------------------------------------------------------- recipe
def piece_at_playhead(y):
    """The pill on row y starting at the playhead (already split), else None."""
    for r in pills_on(y):
        if abs(r["x"] - T.PLAYHEAD_X) < 8:
            return r
    return None


def split_or_reuse(y, text):
    """Idempotent: split the row at the playhead and retext the right piece;
    if the row is already cut here, just fix the text."""
    r = piece_at_playhead(y) or split_at_playhead(y)
    if not r:
        return False
    if r["label"] == text:
        return True
    return retext(r, text)


def sections(spec):
    T.to_start()
    for name, iq in spec["sections"]:
        c = T.scroll_to_caption(name.lower())
        if not c:
            log("!! caption not found:", name); continue
        ok1 = split_or_reuse(header_rows()[0], name)
        ok2 = split_or_reuse(header_rows()[1], iq)
        log("section", name, "name", ok1, "gold", ok2)
    c = None
    for cue in ("want to know", "wanna know", "I made"):
        c = T.scroll_to_caption(cue, tries=6)
        if c:
            break
    if not c:
        log("!! CTA caption not found"); return
    ok = split_or_reuse(header_rows()[0], spec["cta"][0])
    gy = header_rows()[1]
    r = piece_at_playhead(gy) or split_at_playhead(gy)
    if r:
        delete(r)
    log("cta", ok, "gold tail deleted", bool(r))


def build(spec, duration_s, tracks=True):
    """spec = {"hook": [line1, line2], "sections": [[name, iq], ...], "cta": [text, None]}"""
    if tracks:
        target = duration_s * PT_PER_SEC - 8
        name_y = create_at_start(spec["hook"][0], 40, ET.NAME_FRAC)
        set_width(name_y, spec["hook"][0], target)
        gold_y = create_at_start(spec["hook"][1], 30, ET.IQ_FRAC, gold=True)
        set_width(gold_y, spec["hook"][1], target)
    sections(spec)


if __name__ == "__main__":
    import json
    spec = json.load(open(os.environ.get("UGC_HEADERS", "headers.json")))[sys.argv[1]]
    if "--clear" in sys.argv:
        clear_headers()
    build(spec, float(sys.argv[2]))
