# ugc/ — the reel pipeline (Palmier Pro → iPhone → Instagram Edits → Instagram)

Raw talking-head takes in, finished captioned reels posted from a real iPhone out, in
your format, the same way every time. Claude does the operating; this folder is what it
operates with.

**Start with the setup guide in the dashboard** (it opens on first launch of
<http://127.0.0.1:3000>; "Setup guide" in the top bar reopens it). Step 1 gives you
[`SETUP_PROMPT.md`](SETUP_PROMPT.md) to paste into Claude — Claude walks you through the
machine setup. Step 3 gives you [`AGENT_PROMPT.md`](AGENT_PROMPT.md) — Claude runs the pipeline.

## Requirements (once)

- macOS with **full Xcode** (latest), signed in with your Apple ID
- an **iPhone** on the latest iOS with **Developer Mode** on, trusted, USB
- **Palmier Pro** running with its MCP server on (127.0.0.1:19789)
- `brew install ffmpeg` and `pip3 install -r ugc/requirements.txt`
- **Instagram Edits** and **Instagram** installed and logged in on the phone
- this dashboard running with the phone registered (`docs/getting-started.md`)

Check it all: `bash ugc/check_setup.sh`

## What's here

| | |
| --- | --- |
| `SETUP_PROMPT.md` | Paste into Claude first. It runs you through Xcode, the phone, Palmier Pro, this dashboard, and verifies everything. |
| `AGENT_PROMPT.md` | Paste into Claude with this repo attached. Explains the software, the two stages, the rules, and how to behave on the first run. |
| `docs/palmier-pipeline.md` | Stage A: intake → dead-space cut → overlays → Palmier assembly → bake → verify. |
| `docs/edits-app-runbook.md` | Stage B: driving Instagram Edits on the phone. §15 is the unattended recipe. |
| `docs/example-agent-runbook-iq-reels.md` | One finished format with all its numbers, as a worked example. |
| `*.py` | The scripts (see the table in `AGENT_PROMPT.md` §6). |
| `examples/` | A real Palmier build, the music bake, a `headers.json`. |

## The two stages, in one breath

1. **Palmier**: Claude transcribes and renames your takes, cuts every pause, places your
   images, assembles and exports, bakes the music, transcribes the result to prove nothing
   was lost — and hands you the video. You give feedback until it's right.
2. **Edits**: Claude asks you a few very specific questions (headers, fonts, positions,
   caption — sound is already baked in from stage 1), writes them into `headers.json`, then runs each video through Edits on the
   phone and into the Instagram composer:
   ```sh
   python3 ugc/edits_pipeline.py finished.mp4 <key> --headers headers.json --stay
   python3 ugc/ig_share_trial.py <key>      # or --post above for a normal reel
   ```

Measured on an iPhone 13 Pro. Other screen sizes need the playhead x and preview frame
re-measured (`edits_timeline.PLAYHEAD_X`, `edits_text.PREVIEW_Y0/PREVIEW_H`).
