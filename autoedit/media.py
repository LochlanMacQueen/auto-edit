"""Deterministic media work: probing, transcription, dead-space detection with the
per-span isolation check, overlay PNGs, music bake, verification, frames."""
import json
import re
import subprocess
from pathlib import Path

from .config import HOME, WHISPER_MODEL

FF = ["ffmpeg", "-v", "error", "-y"]


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def probe(path) -> dict:
    out = run(["ffprobe", "-v", "error", "-show_entries",
               "stream=codec_type,width,height,avg_frame_rate:format=duration",
               "-of", "json", str(path)]).stdout
    j = json.loads(out or "{}")
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), {})
    a = any(s.get("codec_type") == "audio" for s in j.get("streams", []))
    fr = v.get("avg_frame_rate", "0/1")
    num, den = (fr.split("/") + ["1"])[:2]
    fps = round(float(num) / float(den), 3) if float(den) else 0
    return {"path": str(path), "duration": round(float(j.get("format", {}).get("duration", 0)), 3),
            "width": v.get("width"), "height": v.get("height"), "fps": fps, "audio": a}


# ---------------------------------------------------------------- transcription
def _cache_path(path):
    p = Path(path)
    return HOME / "tmp" / f"{p.stem}-{p.stat().st_size}.transcript.json"


def transcribe(path, force=False) -> dict:
    """Word-timestamped transcript (mlx-whisper), cached by file size."""
    cp = _cache_path(path)
    if cp.exists() and not force:
        return json.loads(cp.read_text())
    import mlx_whisper
    r = mlx_whisper.transcribe(str(path), path_or_hf_repo=WHISPER_MODEL, word_timestamps=True)
    segs = [{"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"].strip(),
             "words": [{"w": w["word"].strip(), "s": round(w["start"], 2), "e": round(w["end"], 2)}
                       for w in s.get("words", [])]} for s in r["segments"]]
    out = {"path": str(path), "text": r["text"].strip(), "segments": segs}
    cp.write_text(json.dumps(out))
    return out


def _transcribe_range(path, s, e) -> str:
    wav = HOME / "tmp" / f"_span_{Path(path).stem}_{s:.3f}_{e:.3f}.wav"
    run(FF + ["-ss", f"{s:.3f}", "-to", f"{e:.3f}", "-i", str(path), "-ac", "1", "-ar", "16000", str(wav)])
    import mlx_whisper
    r = mlx_whisper.transcribe(str(wav), path_or_hf_repo=WHISPER_MODEL)
    wav.unlink(missing_ok=True)
    return r["text"].strip()


# ---------------------------------------------------------------- dead space
HALLUCINATIONS = {"thankyou", "thanksforwatching", "you", "bye", "thankyouforwatching", "subscribe", "sothanksforwatching"}

def speech_spans(path, noise_db=-28, min_silence=0.25, lead=0.07, tail=0.13,
                 min_seg=0.35, merge_gap=0.12, validate=True) -> dict:
    """Speech = complement of silencedetect, padded. With validate=True every span
    is transcribed ALONE: spans with no words are marked drop, and a span whose text
    is repeated at the start of the next span is flagged as a false start."""
    dur = probe(path)["duration"]
    log = run(["ffmpeg", "-i", str(path), "-af", f"silencedetect=n={noise_db}dB:d={min_silence}",
               "-f", "null", "-"]).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", log)]
    sil = list(zip(starts, ends + [dur] * (len(starts) - len(ends))))
    spans, cur = [], 0.0
    for a, b in sil:
        if a > cur:
            spans.append([cur, a])
        cur = max(cur, b)
    if cur < dur:
        spans.append([cur, dur])
    padded = [[max(0.0, a - lead), min(dur, b + tail)] for a, b in spans]
    merged = []
    for a, b in padded:
        if merged and a - merged[-1][1] < merge_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    merged = [[round(a, 3), round(b, 3)] for a, b in merged if b - a >= min_seg]
    out = [{"start": a, "end": b, "dur": round(b - a, 3)} for a, b in merged]
    if validate:
        for sp in out:
            sp["text"] = _transcribe_range(path, sp["start"], sp["end"])
            if not re.search(r"[A-Za-z0-9]", sp["text"]):
                sp["drop"] = True
                sp["why"] = "no words (breath/noise)"
            elif sp["dur"] < 0.8 and re.sub(r"[^a-z]", "", sp["text"].lower()) in HALLUCINATIONS:
                sp["drop"] = True
                sp["why"] = f"whisper hallucination on a noise tail ({sp['text']!r})"
        norm = lambda t: re.sub(r"[^a-z0-9 ]", "", t.lower()).split()
        for i in range(len(out) - 1):
            a, b = norm(out[i].get("text", "")), norm(out[i + 1].get("text", ""))
            if 2 <= len(a) <= 6 and b[:len(a)] == a:
                out[i]["possible_false_start"] = True
                out[i]["why"] = "next span restarts with the same words — usually cut this one"
    keep = [s for s in out if not s.get("drop")]
    return {"path": str(path), "duration": dur, "spans": out,
            "speech_seconds": round(sum(s["dur"] for s in keep), 3),
            "hint": "Review possible_false_start spans against the words; whisper stretching the last word before a pause is NOT a repeat."}


# ---------------------------------------------------------------- overlays
def overlay_band(image, out, box, canvas=(1080, 1920), y_offset=0.5) -> str:
    """Center-crop `image` to the aspect of box=(x,y,w,h), scale, place on a
    transparent full-frame canvas. Full-frame PNGs need no transforms in Palmier."""
    x, y, w, h = box
    crop = f"crop='min(iw,ih*{w}/{h})':'min(iw,ih*{w}/{h})*{h}/{w}':'(iw-ow)/2':'(ih-oh)*{y_offset}'"
    r = run(FF + ["-f", "lavfi", "-i", f"color=c=black@0.0:s={canvas[0]}x{canvas[1]},format=rgba", "-i", str(image),
                  "-filter_complex", f"[1:v]{crop},scale={w}:{h}[img];[0:v][img]overlay={x}:{y}:format=auto,format=rgba",
                  "-frames:v", "1", str(out)])
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-400:])
    return str(out)


def overlay_fit(image, out, max_w, max_h=None, bottom=None, top=None, canvas=(1080, 1920)) -> str:
    """Scale `image` to fit max_w x max_h (aspect kept), centred horizontally, with its
    bottom edge at `bottom` px (or top edge at `top`)."""
    scale = f"scale={max_w}:{max_h}:force_original_aspect_ratio=decrease" if max_h else f"scale={max_w}:-1"
    ypos = f"{bottom}-h" if bottom is not None else (str(top) if top is not None else "(H-h)/2")
    r = run(FF + ["-f", "lavfi", "-i", f"color=c=black@0.0:s={canvas[0]}x{canvas[1]},format=rgba", "-i", str(image),
                  "-filter_complex", f"[1:v]{scale}[img];[0:v][img]overlay=(W-w)/2:{ypos}:format=auto,format=rgba",
                  "-frames:v", "1", str(out)])
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-400:])
    return str(out)


# ---------------------------------------------------------------- finishing
def bake(src, out, music=None, music_db=-16.0, fade_out=2.0, fps=60, trim_first_frame=True, crf=19) -> dict:
    """Trim Palmier's corrupt first frame, force fps, bake the song under the voice
    (song looped if shorter, faded out over the last `fade_out` s)."""
    dur = probe(src)["duration"]
    cmd = FF[:]
    if trim_first_frame:
        cmd += ["-ss", f"{1/fps:.4f}"]
    cmd += ["-i", str(src)]
    if music:
        fo = max(0.0, dur - (1 / fps if trim_first_frame else 0) - fade_out)
        cmd += ["-stream_loop", "-1", "-i", str(music), "-filter_complex",
                f"[1:a]volume={music_db}dB,afade=t=out:st={fo:.3f}:d={fade_out}[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]",
                "-map", "0:v", "-map", "[a]"]
    cmd += ["-r", str(fps), "-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    r = run(cmd)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-600:])
    return probe(out)


def verify(path, expected_words=None) -> dict:
    """The acceptance test: transcript of the finished file + spec + speech coverage."""
    p = probe(path)
    t = transcribe(path, force=True)
    # coverage from the transcript's own segments: music under the voice would fool silencedetect
    spoken = sum(max(0.0, s["end"] - s["start"]) for s in t["segments"])
    gaps = [round(b["start"] - a["end"], 2) for a, b in zip(t["segments"], t["segments"][1:]) if b["start"] - a["end"] > 0.6]
    out = {"probe": p, "transcript": t["text"], "speech_seconds": round(spoken, 3),
           "coverage": round(spoken / p["duration"], 3) if p["duration"] else 0,
           "long_pauses": gaps, "hint": "coverage ≈ 0.9–1.0 and no long_pauses means the dead space is gone; read the transcript for repeats and clipped words",
           "segments": [[s["start"], s["text"]] for s in t["segments"]]}
    if expected_words:
        norm = lambda s: re.sub(r"[^a-z0-9 ]", "", s.lower()).split()
        got = set(norm(t["text"]))
        missing = [w for w in norm(expected_words) if w not in got]
        out["missing_words"] = missing[:40]
    return out


def frame(path, t, out) -> str:
    r = run(FF + ["-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1", "-vf", "scale=360:-1", str(out)])
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-300:])
    return str(out)


def contact_sheet(path, out, cols=6, rows=3, every=1.0) -> str:
    r = run(FF + ["-i", str(path), "-vf", f"fps=1/{every},scale=200:-1,tile={cols}x{rows}", "-frames:v", "1", str(out)])
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-300:])
    return str(out)
