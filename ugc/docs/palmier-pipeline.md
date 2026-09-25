# SOP — "Subject edition" IQ reels (paste this into a fresh Claude chat)

Everything below is the full brief. A Claude session with zero prior context should be able to
follow it start to finish. Replace the bracketed values at the top, then hand it over.

---

## Fill these in first

- **Project folder:** `~/<FOLDER>` (e.g. `~/Neurobank UGC`) — create it if it doesn't exist
- **Reference reel:** `<INSTAGRAM_REEL_URL>`
- **Raw clips:** wherever they are right now (a Downloads folder, an AirDrop dump, etc.)
- **How many subjects per video:** 3, 4, or 5
- **How many variations:** N
- **Where the finished files go:** `~/Downloads` unless I say otherwise

---

## What we're making

Vertical talking-head reels in the format "What your favourite subject says about your IQ."
Each video is:

```
one hook  →  3-5 subject segments  →  one call to action
```

Over the top third of the frame sits a band of aesthetic images: **two per subject**, swapping
partway through. The CTA shows app screenshots instead. There is **no text anywhere in the
video** — no captions, no headers, no titles. The talking head and the images carry it.

**Output spec: 1080×1920, 60 fps, no music.**

The single most important thing is **cutting dead space**. I record each sentence separately
with long pauses between them, so a 27-second raw clip is often only 9 seconds of actual
speech. Every pause has to come out. Everything that matters stays in. If the finished video
has silence in the middle of a segment, it's wrong.

---

## Tools you'll need

- **Palmier Pro** — the editor. It exposes an MCP server on `http://127.0.0.1:19789/mcp`, but it
  does *not* load into a running Claude session. Drive it over raw JSON-RPC (see
  "Palmier bridge" at the bottom).
- **ffmpeg / ffprobe** — already installed.
- **yt-dlp** via `python3 -m yt_dlp` — for the Instagram download.
- **mlx-whisper** (`pip3 install mlx-whisper`) — for transcription. First run downloads ~1.5 GB,
  so kick it off early in the background. Palmier's `inspect_media` also returns a transcript
  and is a fine second opinion; using both is how you catch mistakes.
- **The built-in browser** — for Pinterest.

---

## Step 1 — Folder layout

```
<FOLDER>/
  Components/
    Clips/        the renamed talking-head takes
    Refs/         the reference reel
    Audios/       songs (unused — we don't add music)
  Assets/
    Cards/
      pins/       the chosen Pinterest images, 2 per subject
      *.png       app screenshots for the CTA
  Work/<M-D>/     build scripts, overlays, pin candidates, scratch
  Finished Videos/<M-D>/
```

Move the raw clips into `Components/Clips/` **before** you import anything into Palmier.
Palmier references media files *in place* — if you rename or move a file after importing it,
every asset that pointed at it breaks silently.

## Step 2 — Get the reference

```bash
cd "<FOLDER>/Components/Refs" && python3 -m yt_dlp -o "reference.%(ext)s" "<INSTAGRAM_REEL_URL>"
```

Then work out its structure. Two things you need from it:

**The shape** — build a contact sheet and read it:
```bash
ffmpeg -y -i reference.mp4 -vf "fps=1,scale=288:-1,tile=6x3" -frames:v 3 sheet%02d.jpg
```
Count the subject segments and note the hook and CTA lengths.

**The image timings** — run scene detection on just the image band, which isolates the moment
each picture swaps:
```bash
ffmpeg -i reference.mp4 -vf "crop=1300:660:70:310,select='gt(scene,0.15)',metadata=print:file=-" \
  -an -f null - 2>&1 | grep pts_time
```
On the reference I analysed this gave a clean rhythm: **two images per subject, each held 3.0
seconds, with a ~0.4 second gap between them**, the first appearing exactly when that subject's
voiceover starts. Confirm it still holds for the reel you're given.

## Step 3 — Transcribe and rename every clip

Transcribe all of them. Classify each as a hook, a subject, or a CTA — it's obvious from the
words. Then rename **on disk**:

- subject clips → the subject name: `math.MOV`, `computer-science.MOV`, `political-science.MOV`
- hooks → `hook-<last 4 digits of the original filename>`: `hook-0885.MOV`
- CTAs → `CTA-<last 4 digits>`: `CTA-0908.MOV`

This matters — it's how any future session knows what's in the folder without re-transcribing.

## Step 4 — Find the dead space

For every clip, get the speech spans:

```bash
ffmpeg -i clip.MOV -af "silencedetect=n=-28dB:d=0.25" -f null - 2>&1 | grep silence_
```

Speech is the **complement** of the detected silence. Pad each span by **0.07 s at the head and
0.13 s at the tail**, drop anything shorter than ~0.35 s, and merge spans that end up closer
than 0.12 s apart.

`-28dB` is the right gate. Don't use `-35dB` — it reads room tone as speech and both invents
onsets and clips quiet tails.

### Then validate every span against the words. Do not skip this.

Cross-reference each span with the word-level transcript and throw out:

- **Spans containing no words at all** — these are breaths, chair creaks, a bump at the top of
  the take. Common, and they add silence back in if you keep them.
- **False starts.** Real ones exist. In my 9-21 batch the `anthropology` take says
  "…between 110 and 125 **because you're fascinated**," pauses, then restarts with
  "**This is because you're fascinated by different cultures**." Keeping both makes the line say
  it twice. Cut the first.

**One trap:** whisper stretches the last word before a pause so its timestamp spans the entire
silence. That makes the same word look like it appears at the end of one span *and* the start of
the next. It is not a duplicate — the word is spoken once, right before the pause. Don't
"fix" it; you'll chop a real word off.

## Step 5 — Pinterest images

Two per subject. Search term is literally `<subject> aesthetic` — "math aesthetic",
"geology aesthetic".

Use the built-in browser, and **open each search with `preview_start` in a fresh tab**.
In-tab `navigate` and batched calls both leave the Pinterest SPA blank, and JavaScript that
runs before the page renders returns zero images. One tab per subject; close them at the end.

Scroll in JS and collect image paths matching `i.pinimg.com/<size>/<aa/bb/cc/hash.jpg>`, then
download at `https://i.pinimg.com/736x/<path>`. Pull ~14 candidates per subject.

**Judging them:** preview candidates *already cropped to 2:1*, because that's the only part that
ends up on screen. Reject:

- anything with a title word baked into the image ("ECONOMICS" in bubble letters)
- white-background cutout collages — they punch a hole in the frame
- diagrams covered in text labels
- images that are the wrong subject entirely (searching "anthropology aesthetic" surfaces
  results for a clothing retailer with a similar name)

Keep the moody, photographic ones. Handwritten notes are fine — the reference itself uses them.

## Step 6 — Build the image overlays

Composite each chosen image onto a **full-frame 1080×1920 transparent PNG**, positioned in the
band. Doing it this way means Palmier needs no transform at all, which removes a whole class of
positioning bugs.

Band geometry, center-cropped to 2:1: **x 50, y 232, width 980, height 497.**

```bash
ffmpeg -y -f lavfi -i "color=c=black@0.0:s=1080x1920,format=rgba" -i pin.jpg \
  -filter_complex "[1:v]crop=iw:iw*497/980:0:(ih-iw*497/980)/2,scale=980:497[img];\
[0:v][img]overlay=50:232:format=auto,format=rgba" -frames:v 1 ov_subject_1.png
```

For the CTA, do the same with the app screenshots: the App Store card at width 861, x 110,
y 250; the score card at height 560, centred, y 200.

## Step 7 — Assemble in Palmier

Create the project at **1080×1920, 60 fps** (`set_project_settings {fps:60, width:1080,
height:1920}`). The source clips are 60 fps — a 30 fps project throws away half the frames.

Import `Components/Clips/` and the overlay folder. Then per variation, one timeline:

**Video track** — every speech span as its own clip, butted together with no gaps, in order:
hook → subject 1 → subject 2 → … → CTA.

**Overlay track** — per subject segment, measuring from where that segment starts:
- image 1 from `start` for 3.0 s
- image 2 from `start + 3.4 s` to the end of the segment
- if a segment is too short for the second image, just show the first

For the CTA: **App Store card at +3.4 s for 2.2 s, then the score card held all the way to the
end of the video.** Nothing before the app card.

**No music.** The reference has a music bed; ours don't.

### Palmier things that will bite you

- `add_clips` with no `trackIndex` creates a new track *and shifts every existing index*.
  Re-read `get_timeline` afterwards before any index-based call.
- Source spans round to whole frames, so ask for `source: [s, s + n/fps]` where
  `n = round(duration * fps)`. Otherwise you get occasional 1-frame gaps that flash black —
  sweep the finished track for them and close them with `durationFrames`.
- Adding a clip over an occupied range on the same track *replaces* what's there.
- The active timeline silently follows whatever is open in the app. Set it explicitly and
  assert the name at the top of every batch of edits.
- Don't leave other projects open — close them.

## Step 8 — Export and verify

Export H.264, "Match Timeline", per timeline.

**The first exported frame has corrupted colour** (a known Palmier bug — the timeline itself
renders fine). Trim one frame on the way out:

```bash
ffmpeg -y -ss 0.0167 -i raw.mp4 -r 60 -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart "~/Downloads/<name>.mp4"
```

**Then transcribe the finished file and read the transcript end to end.** This is the real
check and it is not optional — it's what catches clipped words and duplicated false starts,
and it caught a genuine one on this batch after the timeline looked perfect. A good result is
speech time ≈ video duration (e.g. 41.2 s of speech in a 41.3 s video). Also confirm
`ffprobe` reports `1080,1920,60/1`.

## Step 9 — Report back

Give me a table: filename, length, which hook, which subjects, which CTA. Flag anything you
had to drop or work around.

---

## Palmier bridge (needed once)

Palmier's MCP server won't load into a live session, so talk to it directly. Create
`ugc/palmier_mcp.py`: a small JSON-RPC client that POSTs to `http://127.0.0.1:19789/mcp`,
does `initialize` → `notifications/initialized` → `tools/call`, sends the session id back in an
`MCP-Session-Id` header, and parses Server-Sent-Event responses (`data:` lines, records split on
blank lines). Cache the session id in a file and re-initialise on a 404. Give it two entry
points, `list` and `call <tool> <json-args>`.

Sanity check:
```bash
python3 ugc/palmier_mcp.py list
```

---

## The short version

Cut every pause. Keep every word. Two images per subject, 3 seconds each, 0.4 second gap.
App card then score card on the CTA. No text, no music. 1080×1920 at 60 fps. Trim the first
frame. **Transcribe the finished file before you call it done.**
