# SOP — driving the Instagram Edits app on the iPhone

Learned by driving the real device 2026-09-23/24. Code lives in `~/ugc-ops/`:
`phone.py` (driver), `edits_headers.py` (split/retext), `edits_text.py`
(create/position/size). Reference geometry: `Work/923/ref_geometry.json`.

---

## 1. The stack

The phone farm (`~/Lochs-IOS-Agents`) runs four processes: Appium :4725,
WDA :8100, worker, dashboard. **Watch at http://127.0.0.1:3000** — the device
page streams the phone live.

Automation talks **straight to WDA on :8100**. The dashboard's `/api/...` routes
sit behind a CSRF guard and reject unauthenticated writes.

- Device `00008110-00096969368A801E`, iPhone 13 Pro, **390 x 844 points**
- Edits bundle id **`com.burbn.basel`**
- Screenshots come back at 1170 x 2532 px = **3 px per point**

## 2. Four rules that each cost an hour

**Never create a WDA session mid-edit.** `POST /session` — even with no
`bundleId` — throws the foreground app to the home screen and loses editor
state. This rules out `/wda/keys`; text is typed by tapping the keyboard.

**Never batch key presses into one `absolute-actions` call.** A multi-point
pointer sequence is read as swipe-typing (QuickPath) and returns a *predicted
word*: "What your IQ is" came out "Whaleboats", then "Whatever's". One discrete
tap per key, ~0.14 s apart.

**Letter keys change case with shift.** Their a11y labels are uppercase while
shift is engaged, lowercase otherwise; positions never move. Normalise single
letters to lowercase when building the key map, or every lookup misses the
moment shift turns on. Read shift state from the shift Button's value
(`'1'` = engaged) rather than tracking it — iOS auto-capitalises the first
character of a field and drops shift after each letter.

**Track y positions MOVE — never hardcode them.** This is the single biggest
source of silent failure. The header track sits at y=563 normally, **583** when
the context toolbar is showing, and extra overlay tracks appear at **543** and
above. Hardcoding 563/603 caused: a duration map that reported nonsense, resize
drags that silently scrolled instead of resizing, pills that "disappeared", and
new elements landing on the wrong track. Detect tracks dynamically: collect
pills (height 30-42, y between 500 and 720), group by y, and identify the
**caption track as the one whose labels are longest** (captions are sentences).

## 3. Getting the video onto the phone

```
POST http://127.0.0.1:8100/wda/import-media
{"name": "...", "mimeType": "video/mp4", "data": "<base64>"}
```

Returns a `localIdentifier`. Limit 350 MB (the file is base64'd into the JSON
body). Lands at the front of Photos → Recents.

## 4. Building the project

Projects → **+** → *Video: Gallery* → newest clip → blue check. Bottom toolbar:
Audio, Text, Voice, Links, Captions, Filters, Add.

**Captions:** Captions → *Generate Captions* (~20 s). Styling is automatic and
already matches the reference — word-by-word, white, outlined. Do not restyle.

Caption pills carry their **full sentence as the a11y label** and are aligned to
the speech, so every header boundary can be aligned to a caption with no time
arithmetic — both are in the same coordinate space.

## 5. Text styling (set once, it persists)

With the text editor open, tap a selector button to open its panel; the panel's
own row then appears at **y=436**:

```
Editor(32)  Combined(86)  Font(140)  Colour(195)  Animation(250)  Effect(304)  Outline(358)
```

- **Outline:** far-right (358, 436) → pick *Outline*
- **Font:** (140, 436) → **Classic**
- **Colour:** (195, 436) → suggested swatches, incl. **#FFD400 gold** at (195, 666)

Confirm from a11y labels (`Default Outline,`, `Font, Selected`) rather than
trusting the tap. The selector row at y=484 is overlapped by the text field —
tapping it there triggers iOS text selection instead. Always go via the y=436
panel row.

## 6. Headers

A text element created on a free track spans the **whole video**; one created
where the track is already occupied gets a **~2.7 s default (195 pt)** and lands
on a **new overlay track**.

**Preferred recipe** — one full-length element, split and re-texted:

1. Scroll so the caption that starts the next section sits under the playhead.
   **The playhead is at screen x=195.** (Measure it by splitting, not from
   pixels — a pixel scan gave 149 and put the first cut 0.5 s late.)
2. Select the header pill on the timeline → **Split**.
3. Tap the header **on the canvas** once (yellow box), **again** to open the
   editor; clear, retype, Done. Tapping the *timeline pill* twice never opens
   the editor.

**Timeline scrolling stalls:** drags under ~15 pt do not register, leaving up to
~10 pt ≈ 0.14 s residual. Imperceptible for a header switch — do not chase it.
When a resize needs less than ~20 pt, scroll for more room instead of retrying.

**Resizing a pill:** grab within 2 pt of its edge, on **its own track's y**.
Dragging the pill body moves the element (it once flew to x=-5126). Iterate and
re-measure; aiming past the target is what causes the body-grab.

## 6b. Headers — what finally worked (2026-09-24, later)

**Make the gold IQ line by DUPLICATING the career header, not by creating text.**
Select the name pill on the timeline → *Duplicate*. The copy has exactly the
same start and duration (no resizing, ever) and lands on the overlay track
above. It is still selected, so **one** tap on the canvas text opens its
editor; retype, colour, size, position, Done. Creating a new element instead
gives a fixed ~2.7 s default that cannot be reliably extended.

**`text_value()` is NOT a safe verification while several text elements
exist** — it returns the first TextView in the tree, which is often another
element's canvas text. Typing was working the whole time it "failed". Verify
by reading the **timeline pill label** (it updates with the text) or by a
screenshot, never by `text_value()` alone. Never run a clear-and-retype loop on
the strength of a `text_value()` mismatch: it hammers delete into whatever is
focused and discards elements.

**Canvas taps are ambiguous when two elements overlap** (a duplicate sits
exactly on its source; a two-line name spans the gold line's y). Select the
target's pill first, then tap the canvas at the target's *own* rendered y
(measure the white or gold band), not at a fixed 211.

**The caption row does not scroll the timeline.** Horizontal swipes on the
bottom (caption) row do nothing; the overlay rows above it scroll. Use the
lowest non-caption track for scrolling. `edits_timeline.scroll_row()` does this.

**Layout rule change:** the IQ line now sits at **0.385** of frame height (the
reference's 0.3512 collides with two-line names like "Software Developer").
Name line 0.3025 at size 36-40; IQ line size 30-32, gold #FFD400; hook name
line at 40 (52 wrapped to two lines).

**Track budget:** every duplicate/new element adds an overlay track; above
about three, the top ones slide behind the ruler and can be tapped but not
dragged. Delete stray copies immediately (`delete_pill`) and keep the gold
lines on one track where their time spans don't overlap.

## 7. Geometry, measured from the reference reel

Colour-detected from `reference-DdXXRS1x1VG.mp4` (1440x2560) — the name line is
white, the IQ line gold, so they separate cleanly:

| line | centre y (frac) | cap height (frac) | colour |
| --- | --- | --- | --- |
| career / subject name | **0.3025** | 0.0340 | white |
| IQ range | **0.3512** | 0.0297 | **gold #FFD400** |

Both horizontally centred. In the Edits canvas the video frame spans
**y = 112 .. 444** (332 pt), so name ≈ y 212, IQ ≈ y 229.

The **"Resize text"** slider (vertical, left edge, tap x≈5) exposes its value in
a11y, and **that value equals the rendered cap height in screenshot pixels**.
Reference target ≈34; Lochlan asked for the hook line bigger — it is at 52.
Dragging the slider 3 pt changes it by 1 unit. Long strings auto-shrink to fit
frame width, so the CTA line renders smaller — that is correct.

Canvas drags have a **gain of ~0.65** (a 44 pt drag moves 29 pt). Iterate:
screenshot, measure the white (or gold) band, nudge, repeat.

## 8. Gotchas

- The context toolbar (Split / Edit / Copy / Delete / Duplicate / Opacity)
  *replaces* the main toolbar while a pill is selected. Tap `back-button` to
  deselect before reaching for Text / Audio / Captions.
- "Edit" in the context toolbar opens **preview mode**, not the text editor.
- Look up toolbar buttons by a11y label every time; they are not at fixed
  coordinates between states.
- Wait for the keyboard (`wait_keyboard()`) — a tap that opens an editor does
  not mean the keyboard has rendered.
- Never run a clear-and-retry loop on a **fresh** element: hammering delete on
  an empty field dismisses the editor and discards the element.
- Accessibility rects are **not** clipped to the viewport; a pill can report
  x=-843 or width=1534. Off-screen pills must be scrolled into reach before
  they can be tapped or dragged.
- To map the whole timeline, scroll to the start, then page right recording
  pills and computing the offset from a pill visible in both frames.

## 9. State of the 9-24 practice project

Header line 1 (white) is **correct and verified**:

```
What your IQ is       -0.03 →  2.30     caption starts  0.00
Teacher                2.30 →  9.22     caption starts  2.17
Lawyer                 9.22 → 16.73     caption starts  9.33
Software Developer    16.82 → 24.72     caption starts 16.85
Do you know your IQ?  24.59 → 32.23     caption starts 24.75
```

Line 2 (gold): `(Career edition)` is correct at -0.03 → 2.65. **The three IQ
lines are wrong** — `105-120IQ`, `115-130IQ`, `120-135IQ` were created while the
boundary lookup was still using the stale hardcoded track y, so they landed at
32-40 s (past the end of the video) and two of them on the caption track. They
must be deleted and rebuilt now that detection is dynamic.

## 10. Still to do

- Rebuild the three gold IQ lines at their correct boundaries
- **Audio:** add the sound, cut at 18 s, fade out the last 2 s, duplicate it,
  fade the copy in over its first 2 s, and overlap those 2 s. Repeat for as many
  copies as the video length needs.
- **Export** and the trial-reel path.

**Never post.** Lochlan verifies every video visually first. Account check is
the profile picture bottom-right (`intelligentadrian`).

## 11. Audio (learned 2026-09-24)

- Bottom toolbar **Audio** opens a sheet: search bar, tabs *For you / Trending /
  Original audio / Royalty-free*. **"New Computers" (Girlfriends, 2:11)** and
  **"Golden Brown (Slowed Down Version)"** both appear in *For you*.
- **Do not dismiss the sheet with a downward swipe from the top** — the swipe
  landed on the first row and silently added Golden Brown to the timeline.
  Dismiss with the sheet's own close control, or tap outside the rows.
- With an audio pill selected the context toolbar is: **Split · Volume ·
  Fade audio · Volume ducking · Delete · …** — *Fade audio* is the control for
  the fade-in / fade-out recipe.
- Adding audio adds an audio track at the bottom, which pushes every overlay
  track up one row — the topmost gold track can slide behind the ruler.

## 12. Audio — what actually worked (2026-09-24)

- The New Computers clip was cut at 18 s with **Split at the playhead + delete
  the tail**, then *Fade audio* → Fade out 2.0 s (slider knob starts at x≈43,
  y≈781 for fade-out / y≈732 for fade-in; the readouts are `N.Ns` StaticTexts
  — filter them with `^\d+\.\ds$`, "Beats" also ends in s).
- **Duplicate** puts the copy on a *second audio row directly below*, at the
  same time. Reaching that row needs the track list scrolled down (vertical
  swipe in the track area); tap the pill's **upper half** (`y+10`) — the video
  strip sits right under it and steals taps.
- Moving clips by drag is unreliable: a plain drag scrolls the timeline (both
  pills shift together), and a long-press "lift" drag can fling the clip when
  the pointer nears the screen edge. Lochlan placed the second copy by hand.
  **Never wipe or re-add the audio** to "start clean" — that undid his work.
- Only three timeline points matter for this recipe: **0 s, 18 s and each
  further multiple of 18 s** (with the 2 s overlap/fades). Do not scroll around
  the middle of the video.

## 13. Export and post (2026-09-24)

1. Editor → **Next** (top right) → alert "HD is the best fit" → **Export in HD**
   (source is 1080p). A11y shows `Export progress: NN%`; wait until it is gone.
2. "Choose where to share" → **Instagram** → hands off to `com.burbn.instagram`,
   which opens the **New reel** composer: caption TextView (16,409), Hashtags,
   *Share as template* switch (on by default), **Save draft** / **Share**.
3. **Account check:** the composer does not name the account. Save draft, then
   on the main feed the story tray's first cell is labelled
   `<username>. Profile picture` — it read `intelligentadrian`.
4. Reopen a draft: Profile → Reels tab → scroll the grid so the **Drafts** tile
   (first tile) clears the tab bar (tab bar starts at y=761; a tap there hits
   *Main feed*) → tap it → a sheet with a full-width **Drafts** cell → the
   list shows **Drafted reel**.
5. Post as a normal Reel (Lochlan: *not* a trial reel).
6. **Caption:** tapping the caption field opens a *Caption* sub-screen with the
   keyboard; you must tap **OK** (top right) to return before *Share* works —
   a Share tap while that screen is up does nothing. Hashtags are optional
   (Lochlan: skip them, they cost time); if adding any, pick them from the
   suggestion list that appears under the field rather than typing them out.
   The composer has a **Trial** switch (`trial-switch`, off by default) — leave
   it off for a normal Reel.
7. After Share the feed shows `Step 1 of 3: Uploading` … then the post is
   live. First live post from this pipeline: 2026-09-24, career edition
   (teacher / lawyer / software developer), caption
   "IQ based on your career #iq #psychology".

## 14. Speed plan adopted 2026-09-24 (Lochlan's decisions)

- **Headers stay in Edits** (must be the Edits text styling); **audio is baked
  into the file in Palmier/ffmpeg** — Golden Brown, full length, −16 dB, 2 s
  fade at the end (`Work/924_bake.sh`). No audio work on the phone any more.
- **WDA session is created once, before Edits opens** (`phone.start_session()`
  then `phone.launch('com.burbn.basel')`). With it, `phone.type_fast()` types a
  whole string in one `/wda/keys` call and `phone.find_fast()` is a predicate
  lookup (~0.2 s vs ~1.7 s for a tree dump). Creating the session mid-edit is
  what threw the app home before — timing, not the session itself.
- Per-video runner: `~/ugc-ops/edits_pipeline.py <video> <key> [--post]`
  (import → new project → captions → headers → export HD → Instagram composer;
  saves a draft unless `--post`). Header text per video comes from
  `Work/924/headers.json`, derived from each video's own transcript.
- 9-24 batch: `Finished Videos/9-24/career{1,2,3}.mp4`, `subject{1,2,3}.mp4`
  (1080x1920, 60 fps, Golden Brown baked, all transcripts verified clean).
  New careers reuse subject pins (engineer←engineering, scientist←chemistry/
  physics, accountant←economics/statistics) — no Pinterest run needed.

## 15. Header recipe v2 — the one that runs unattended (2026-09-24, night)

Code: `~/ugc-ops/edits_headers2.py` (`build(spec, duration_s)`), called by
`edits_pipeline.py` as `headers_v2`. Replaces §6/§6b/Duplicate.

Two full-length tracks, split at every section start:

1. `create_at_start(hook line 1, size 40, NAME_FRAC)` — Text tool at 0, type,
   **font Classic + Outline** (`style_classic_outline`), size, position, Done.
2. `set_width(row, label, duration_s*65.1 - 8)` — drag the right handle in
   ≤230 pt steps. **Never drag blindly "to the end": an overlay past the video
   end EXTENDS THE PROJECT** (career1 briefly became 41 s of black tail).
   PT_PER_SEC = 65.1 (calibrated: 31.0 s caption at 2017 pt). Header, caption
   and thumbnail strip must end at the same x.
3. Same for the gold line (`make_gold` → colour tab (195,436) → swatch
   "Suggested color #FFD400", size 30, IQ_FRAC).
4. For each section: `scroll_to_caption(name.lower())`, `split_at_playhead`
   on the name row then the gold row, `retext` the right-hand piece. Retext =
   select pill → context-toolbar **Edit** button (opens the text editor
   directly — no canvas taps) → clear → `type_taps` → verify → Done.
5. CTA: cue is one of "want to know" / "wanna know" / "I made"; retext name,
   **delete** the gold tail.

Facts that made it work:
- Rows: name track = lowest non-caption y, gold = next up. Re-read after every
  action; the whole band moves 20 pt when the context toolbar shows.
- Verify typed text with `H.editor_value()` = the TextView **below y 440 with
  no label**. `phone.text_value()` returns the first TextView, which is a
  canvas element ("Text on your story") — it read "Engineer" while I typed
  "115-130IQ", the retry hammered delete on the (actually correct) field,
  and an empty field + delete discards the whole element.
- Scrolling: drag from a point with no pill under it (`H.free_point`).
- Text editor extras: tabs at y 436 → Editor 32 · Combined 86 · Font 140 ·
  Colour 195 · Animation 249 · Effect 303 · Outline 358. Font list has
  "Classic" as an exact Button; Outline panel has an Other "Outline" (tap
  ~40 pt below its rect top). "Apply to track" (77,72) is a sticky toggle
  that restyles every element on the track — handy for a one-off fix, but
  turn it back off (it also seemed to shift positions).
- Export: Next → ("Export in HD" only sometimes appears) → wait until the
  Instagram button exists → **terminate com.burbn.instagram first** (WDA
  `/session/{sid}/wda/apps/terminate`) → tap Instagram → wait for "New reel".
  If Instagram is already running the handoff dumps you on the main feed.
- Composer: caption TextView at (16,409) (Instagram remembers the last
  caption); Trial switch is below the fold ("Not checked, Trial"); "Also
  share on…, Intelligentadrian" confirms the account. There is **no Schedule
  option** on this account (More options shows "Add reminder" instead) — to
  space posts 30 min apart, share from the agent at the right wall-clock
  time (`~/ugc-ops/runs/post_times.txt`).
- Career1 timings: hook+extend ≈ 6 min, gold ≈ 6 min, 3 sections + CTA ≈
  12 min, export 17 s.

### 15a. Night run log (2026-09-24 → 25) and the exact commands

```
python3 -u ~/ugc-ops/edits_pipeline.py "<video>.mp4" <key> --stay        # full run, ends in the IG composer
python3 -u ~/ugc-ops/ig_share_trial.py <key>                              # trial switch on + Share (+ logs time)
# resume flags: --no-import  --resume-headers (project already open, wipes headers)  --resume-sections (tracks exist)
```
- career1: hand-finished (recipe was being written). Posted normal 21:46.
- career2: resumed twice (a log() bug, then an editor left open at the CTA —
  fixed by the stricter `done()`). Posted normal 22:36.
- career3: **fully unattended, 37.5 min**, posted trial 23:15.
- Cadence: one video builds while the previous one's 30-minute gap elapses,
  so "30 min apart" needs no scheduler.
- Share button: the Trial row has two Switch nodes — the labelled one
  ("Not checked, Trial, …") ignores taps; tap the unlabelled Switch at the
  same y (ig_share_trial.py does this and asserts "Checked" before Share).
- subject1: unattended 38.6 min; header ended 1.7 s early (set_width ran out
  of iterations — budget raised 40→90), hand-extended the CTA pill, posted
  trial 23:57. subject2: unattended 37.8 min, posted trial 00:35.
  subject3: unattended 38.6 min, posted trial 01:14.
- Verified on the profile 01:18: two new public reels captioned "IQ based on
  your career", four new entries under the Trial reels tile. No leftover
  drafts. Metricool analytics lag — empty for the night, don't rely on it.
