# Agent runbook — IQ "subject edition" reels

Operational notes for a Claude session picking this project up. Terser and more specific than
`SOP-new-chat.md`, which is the from-scratch version for a context-free session. Read this one
when the folder already exists.

---

## Fixed facts

| Thing | Value |
| --- | --- |
| Project root | `~/Neurobank UGC` (consolidated 2026-09-21; the old `~/iq-ugc` was merged in and deleted) |
| Palmier project | `IQ Subjects 9-21` |
| Bridge | `~/ugc-ops/palmier_iq.py`, session file `~/ugc-ops/palmier_session_iq.txt` |
| Output | 1080×1920, **60 fps**, **no music**, **no text** |
| Reference reel | `Components/Refs/reference-DdMqGGkRdIG.mp4` (52.9 s, 5 subjects) |
| Structure | hook → 3-5 subjects → CTA |

Lochlan's standing rules that apply here: never export without approval unless he asked for the
files; adjust existing timelines in place rather than rebuilding; don't leave other Palmier
projects open; never import media from `/tmp` (macOS purges it and the timelines go silent).

## Layout

```
Components/Clips/      21 renamed takes (5 hooks, 13 subjects, 3 CTAs)
Components/Refs/       reference reel + contact sheets
Components/Audios/     songs — NOT used, Lochlan wants these silent
Assets/Cards/pins/     chosen pins, 2 per subject
Assets/Cards/          app_card.png, score_card.png  (usable)
                       app_search.png                (REJECTED, see below)
                       frame_app.png, frame_score.png (composited old frames, not overlays)
Work/921/              build scripts, overlays/, pincand/, sheets/, raw/
Finished Videos/9-21/
```

## Scripts in `Work/921/`

| File | Does |
| --- | --- |
| `speech.py` | silencedetect → padded speech spans → `speech.json` |
| `transcribe.py` | mlx-whisper over `tx/*.wav` → `transcripts.json` (word timestamps) |
| `mkov.py` | pins + cards → full-frame 1080×1920 RGBA overlays in `overlays/` |
| `build6_60.py` | builds all variation timelines at 60 fps (`build6.py` is the stale 30 fps one) |
| `export6.py` | exports each timeline, polls `manage_exports` to completion |
| `verify.py` | transcribes every finished file — **the actual acceptance test** |
| `sheet.py` | contact sheets of pin candidates, cropped 2:1 as they'll appear |

## Constants

```python
FPS      = 60
SILENCE  = "silencedetect=n=-28dB:d=0.25"   # -35dB reads room tone as speech
LEAD, TAIL, MINSEG = 0.07, 0.13, 0.35
BAND     = dict(x=50, y=232, w=980, h=497)  # 2:1 centre crop of the pin
IMG1     = 3.0 * FPS                        # first image on screen 3.0 s
GAP      = 0.4 * FPS                        # then 0.4 s of nothing
CTA_A    = 3.4 * FPS                        # app card starts 3.4 s into the CTA
CTA_ALEN = 2.2 * FPS                        # app card length; score card runs to the end
```

## Measured speech spans (9-21 batch)

Noise and false starts already removed. Source seconds.

```python
"hook-0885":[[0.883,3.749]]  "hook-0886":[[0.680,3.715]]  "hook-0887":[[0.0,2.658]]
"hook-0888":[[0.994,4.073]]  "hook-0889":[[0.662,3.263]]
"math":[[0.0,3.518],[8.612,11.000]]
"physics":[[0.0,3.410],[9.201,12.065],[17.608,20.348]]
"computer-science":[[0.0,3.954],[8.592,10.421],[14.178,16.365]]
"history":[[1.030,3.159],[8.312,10.449],[11.021,13.349]]
"chemistry":[[6.972,10.624],[15.570,18.611],[23.759,26.278]]
"economics":[[0.856,4.736],[10.014,12.417],[18.069,20.849]]
"statistics":[[0.761,4.475],[6.990,9.486],[13.582,15.700],[23.532,26.510]]
"engineering":[[4.523,8.212],[11.848,14.519],[18.771,21.075]]
"astronomy":[[1.893,5.189],[8.078,10.618],[15.919,18.089]]
"political-science":[[0.978,4.864],[8.379,11.391],[17.186,19.298]]
"anthropology":[[5.917,9.885],[16.578,19.147],[23.209,25.574]]
"geography":[[3.357,6.553],[12.118,15.107],[17.959,20.218]]
"geology":[[0.0,3.341],[6.178,9.059],[11.417,14.280]]
"CTA-0906":[[0.0,5.961],[8.173,12.176],[13.711,16.182]]
"CTA-0908":[[1.540,6.532],[7.409,11.392]]
"CTA-0912":[[1.007,6.420],[7.620,11.667],[12.484,16.015]]
```

Two of these carry corrections — don't regress them:

- **`anthropology`** — the span `[15.039,16.154]` is a **false start** ("because you're
  fascinated", then he restarts with "This is because you're fascinated by different
  cultures"). It is removed above. Keeping it makes the line say it twice; this shipped broken
  in the first 30 fps pass and was only caught by transcribing the export.
- **`statistics`** — the third span's tail is extended to `15.700` (silencedetect ends it at
  ~15.44) to keep a quiet trailing "and" before "question whether conclusions are actually
  certain".

## Variations shipped 2026-09-21

| | Hook | Subjects | CTA | Length |
| --- | --- | --- | --- | --- |
| var1 | 0885 | math, physics, computer-science, history | 0908 | 41.3 s |
| var2 | 0886 | chemistry, engineering, statistics, astronomy | 0912 | 53.2 s |
| var3 | 0887 | economics, political-science, anthropology, geography | 0906 | 50.5 s |
| var4 | 0888 | physics, statistics, geology, economics | 0908 | 50.5 s |
| var5 | 0889 | computer-science, engineering, astronomy, math | 0912 | 46.1 s |
| var6 | 0885 | history, geography, anthropology, chemistry | 0906 | 48.5 s |

Uses all 5 hooks, all 13 subjects, all 3 CTAs. With 4 slots × 6 videos = 24 slots against 13
subjects, some reuse across videos is unavoidable; no two videos share a *set*.

## Tool call shapes

```jsonc
// video: one entry per speech span, butted. n = round(dur*FPS); source end = s + n/FPS
{"mediaRef": ID, "startFrame": f, "source": [s, s + n/FPS]}

// stills: frame-exact, no source span
{"mediaRef": ID, "startFrame": a, "endFrame": b}

// project
set_project_settings {"fps": 60, "width": 1080, "height": 1920}
export_project {"mode":"video","codec":"H.264","resolution":"Match Timeline",
                "outputPath": "...", "timelineId": "..."}
```

## Failure modes

| Symptom | Cause / fix |
| --- | --- |
| Every asset broken after a tidy-up | Palmier references media **in place**. Rename and move files *before* importing; re-import after any move. |
| Same word appears at both sides of a cut | Whisper stretches the last word before a pause across the whole silence. **Not** a duplicate — don't trim it, you'll lose a real word. |
| A line is genuinely said twice | A real false start. Check against the word timestamps and cut the first attempt. See `anthropology`. |
| 1-frame black flash between clips | Source-span rounding. Sweep the track for `next.start > prev.end` and fix with `durationFrames`. |
| First frame has wrong colours | Known Palmier export bug; timeline renders fine. Trim one frame: `ffmpeg -ss 0.0167 -r 60 …`. |
| Track indices wrong after adding clips | `add_clips` with no `trackIndex` creates a track and shifts indices. Re-read `get_timeline`. |
| Clips vanished where you added new ones | Same-track overlap replaces. Put overlays on their own track. |
| Edits landed on the wrong timeline | The active timeline follows whatever is open in the app. `set_active_timeline` and assert the name first. |
| Video is 30 fps | Sources are 60 fps. Set the project to 60 **before** building; changing it later rescales frames. |
| Pinterest returns zero images | `navigate` and `browser_batch` leave the SPA blank. Use `preview_start` per subject (fresh tab), then scroll in JS. |
| `silencedetect` prints nothing | `-v error` suppresses its output — it logs at info level. |

## Rejected / decided

- **`app_search.png` is out.** Lochlan called it a bad picture (2026-09-21). The CTA is now
  App Store card → score card **held to the end**. Don't reintroduce a third CTA visual.
- **No music.** The reference reel has a continuous bed; ours don't. `Components/Audios/` stays
  unused unless he says otherwise.
- **No text.** No captions, no headers, no IQ-range numbers, despite the reference having all
  three.
- **5 subjects is the reference's count**, but Lochlan chose 4. Ask if the brief is ambiguous.

## Acceptance test

Run `verify.py`. Read every transcript end to end — not just the speech/duration ratio, which
looks fine even when a line is duplicated. Then confirm `ffprobe` reports `1080,1920,60/1`.

A healthy result is speech time ≈ video duration: 41.2 s of speech in a 41.3 s video means the
dead space is gone. Anything materially below that means a pause survived.

## Open items

- `Work/921/pincand/<subject>/` holds ~14 candidates per subject if picks need swapping.
- No `literature` clip in the 9-21 batch, though the reference uses that subject.
- An in-app **question** screen would make a better middle CTA beat than the App Store card
  alone; there isn't a clean one in `Assets/Cards/`. Capturing one from the simulator was
  offered and declined — worth revisiting.
