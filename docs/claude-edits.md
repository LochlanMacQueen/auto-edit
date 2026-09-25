# Claude + Jev + Edits

The fast path is **one Claude plan → one local recipe → narrow Jev checkpoints → visual review**.
Claude writes the recipe and handles exceptions. Local code performs the mechanical steps
without a model round trip per tap. Jev classifies a compact accessibility observation
when the recipe needs a screen-state decision. It never chooses arbitrary coordinates.

## Setup

1. Get a **TypeSafe** API key from https://console.typesafe.ai. The supplied
   jev-agent.com site is an independent guide/gateway; this integration uses the
   official https://api.typesafe.ai/v1/systemone endpoint and expects a TypeSafe key.
2. Add `TYPESAFE_API_KEY=...` to the local, git-ignored `.env`. Optional:
   `JEV_MODEL=jev-1.13.0` (the pinned default). Restart `npm run web` and
   `npm run worker` after adding the key. No key is sent to the browser.
3. Open the intended Edits project on the phone. The runner never creates a WDA
   session or relaunches Edits. Calibrate any named points used by your recipe.
4. Have Claude read this document and inspect the current screenshot and WDA
   accessibility tree before authoring a recipe. Recipe labels and geometry must
   come from observations, not guesses. Calibrated points can be fetched with
   `GET /api/devices/:udid/coordinates?app=edits`.

## Drive it from Claude

From this repository:

```sh
npm run edits -- validate examples/edits/check-editor.json
npm run edits -- inspect DEVICE_UDID
npm run edits -- submit DEVICE_UDID path/to/recipe.json
npm run edits -- status DEVICE_UDID
```

`submit` queues plugin `local.edits`, task `recipe`, version 1, through the existing
scheduler. The normal per-device queue owns the phone while running; the dashboard
shows progress and supports Stop. Do not also run the old Python driver against that
phone during a batch. For a remote/authenticated dashboard, set `PHONE_FARM_URL` and
optionally `PHONE_FARM_API_TOKEN` in the CLI environment.

The bundled example only checks the current editor and captures a review image.
It makes no editing gestures. A recipe is `{ "title": "...", "steps": [...] }`.
Every step has a unique `id`. End with `{ "id": "review", "op": "review" }`.

Supported steps:

| Operation | Fields | Behavior |
| --- | --- | --- |
| `tap` | `target`, `expect` | Tap one named control, then wait for an observed postcondition. |
| `wait` | `target`, optional `timeoutMs` (up to 120000) | Poll a specific control, rather than a fixed multi-second sleep. |
| `type` | `field`, `previous`, `text`, `verify` | Require the exact previous field value, use Select All for replacement, type separate key taps, verify the specified target. No destructive retries. |
| `swipe` | `from: [x,y]`, `to: [x,y]`, `durationMs`, `expect` | One bounded, measured gesture followed by a postcondition. |
| `align` | `caption`, `scrollTrack`, `playheadX`, optional `tolerance` | Re-read both named tracks and align a visible caption boundary using the overlay row. No fixed track y. |
| `jev` | `expected: ["timeline", ...]` | Require a matching screen with confidence and selected probability at least .85, and no busy signal. Otherwise return to Claude. |
| `review` | — | Save a screenshot and stop for visual review. |

A selector is `{ "label": "Split", "type": "Button" }`; `type` is optional.
Use `minY` and `maxY` to disambiguate repeated labels. A selector without `label`
requires a type and both vertical bounds, useful for an editor field whose label
changes as you type. A tap target can instead be `{ "point": "splitText" }`.
Unset calibration points fail preflight before any edit. Text verification targets
must identify the intended field or timeline element, never the first TextView.

Supported Jev states: `projects`, `media_picker`, `timeline`, `text_editor`,
`text_selected`, `captions`, `audio_picker`, `audio_selected`, `audio_fades`,
`export`, `exporting`, `share`. An uncertain/unknown result requires review.

Every batch writes `.scheduler-data/edits/<execution-id>/result.json` and a
`review.png` on review/error when the phone is available. The result contains
completed step IDs, the current step, per-step timings and errors. Review the
screenshot and send a **new recipe containing only the remaining work**. Failed
mutation steps are never retried automatically: a network failure can mean the tap
succeeded even when its response was lost. Review checkpoints appear as Stopped in
the existing scheduler UI. The CLI's status result includes the execution IDs.

## Build a reusable video recipe

1. Prepare the script, section titles, timing cues and source media before touching
   the phone. Claude should decide all text up front.
2. Open/import once, generate captions once, and use caption labels as boundaries.
3. Make one full-duration styled header; split it at those boundaries. Duplicate
   each segment for the second line so its timing stays identical. Do not create
   lots of short overlays and repeatedly stretch them.
4. Separate text, styling and audio into small verified batches. Use `align` for
   visible caption boundaries and live label selectors for moving context tools.
5. Keep Jev calls at ambiguous state transitions. Exact-label waits already solve
   straightforward transitions without a paid model call.
6. Review after each new macro the first time. Reuse the measured recipe on later
   videos with new text and timing cues. Keep final visual review before posting.

If editable text/timelines inside Edits are unnecessary, the larger speed win is
pre-rendering cuts, headers, captions and cleared/licensed audio on the Mac, then
using Edits only for the finishing/export steps. That is a separate workflow
choice, not implemented by this runner.

## What is and is not measured

Jev currently accepts text/JSON, not images/audio/video. It cannot verify typography,
line placement, musical transitions or video quality. Those need visual/audio
inspection or dedicated local measurement. Official references:
https://docs.typesafe.ai/models and https://docs.typesafe.ai/api.

The adapter records WDA observation time separately from Jev inference time. The
runner records each step's time. Use one representative video to compare wall-clock
time, recovery count and manual interventions before claiming a speed multiplier.
No live Jev request or phone-edit batch has been benchmarked yet; API key and a
supervised representative run are still needed. Keyboard taps are intentionally
separate, and keyboard state reads may remain a major bottleneck. A future tested
sessionless text-insertion WDA extension could reduce that further; it is not part
of this change.

This is the batch execution and decision infrastructure, not an already calibrated
end-to-end video template. Media import and specialized fade/layout macros still
need their project-specific recipe. Existing scripts in `~/ugc-ops` are left intact;
several contain stale fixed-coordinate and clear-and-retry logic, so do not call
them wholesale from this runner.
