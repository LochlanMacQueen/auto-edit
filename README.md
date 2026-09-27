# auto-edit

Raw talking-head takes in, finished captioned reels posted from your iPhone out — edited by Claude or ChatGPT through one MCP server, in your format, every time. Captions and headers are **native Instagram Edits text** and the reel is **shared from the Instagram app**, because that's what gets reach.

**Landing page:** `site/index.html` · **Dashboard:** http://127.0.0.1:4747 · **License:** GPL-3.0 (built on Palmier Pro and Phone Farm iOS)

## Install

**Easiest — the app (one install):** go to **[lochlanmacqueen.github.io/auto-edit](https://lochlanmacqueen.github.io/auto-edit/)** and download **[auto-edit.dmg](https://github.com/LochlanMacQueen/auto-edit-app/releases/latest/download/auto-edit.dmg)**, drag to Applications, allow it once in System Settings → Privacy & Security → Open Anyway (the beta isn't notarized yet). It is the video editor (a GPL fork of Palmier Pro) with this server bundled inside; the auto-edit window opens on launch. Source: [auto-edit-app](https://github.com/LochlanMacQueen/auto-edit-app).

**Server only (use with your own Palmier Pro):**

```sh
curl -fsSL https://raw.githubusercontent.com/LochlanMacQueen/auto-edit/main/install.sh | bash
```

Apple Silicon Mac on macOS 26. The installer brings ffmpeg, Python, whisper, starts the auto-edit server as a launchd agent, builds the Claude Desktop extension and opens the dashboard. Then:

1. Install [Palmier Pro](https://github.com/palmier-io/palmier-pro/releases/latest/download/PalmierPro.dmg) and keep it open (it's the editor; the agent drives it over MCP).
2. Dashboard → **Connect** → add auto-edit to Claude Desktop (`~/AutoEdit/auto-edit.mcpb`, double-click), or Claude Code (`claude mcp add --transport http auto-edit http://127.0.0.1:4747/mcp`), or ChatGPT (through a `cloudflared` tunnel).
3. Say to your agent: *"Run setup_status and walk me through anything that isn't ready."* It finishes the setup with you, including the iPhone bridge.

## How you use it

1. **Put your files in a folder** — takes, images, a song, a reference reel if you have one.
2. **Tell the agent exactly what you want** — structure, what's on screen when, music, length, what must never happen. First time it asks; after that it remembers the format.
3. **Review** — the clean cut lands in the dashboard's Review tab. Approve or send notes; the agent is waiting on your decision.
4. **Edits + post** — the agent asks once how headers/captions should look, then runs each video through Instagram Edits on your phone (native fonts, Classic + Outline by default), parks it for a final look, and shares it from Instagram — normal or trial reel, spaced however you asked. Sound is baked in during the edit, never added in Edits.

## What's inside

| Path | What it is |
| --- | --- |
| `autoedit/` | The MCP server + dashboard (Python, `mcp` 2.x). `server.py` is the tool surface (29 tools: setup, project/transcribe/dead-space, overlays, Palmier proxy + `build_timeline`, export/bake/verify, formats, review, phone jobs, posting queue). `AGENT.md` is what the agent reads on connect. |
| `mcpb-autoedit/` | Claude Desktop extension (stdio → local HTTP shim). |
| `ugc/` | The iPhone recipes the server runs: `edits_pipeline.py` (Edits captions + header tracks + export + Instagram composer), `phone.py` (WebDriverAgent driver), the runbooks. |
| `install.sh`, `site/` | Installer and landing page. |
| everything else | Phone Farm iOS — the dashboard that builds/supervises WebDriverAgent on the phone. Still the way the bridge is installed today (needs Xcode); an in-app signing flow is the planned replacement. |

## Agent tool surface (short)

`setup_status` · `setup_guide` · `project_create` · `takes_overview` · `transcribe` · `rename_take` · `speech_spans` (dead space + per-span isolation transcript: flags breaths, whisper hallucinations and false starts) · `overlay_band` · `overlay_fit` · `palmier_tools` · `palmier` (any Palmier Pro tool) · `build_timeline` (one plan → whole timeline, returns section boundaries) · `export_timeline` · `bake` (first-frame trim, fps, music) · `verify_video` · `video_frame` · `contact_sheet` · `format_save` / `format_list` · `review_submit` / `review_wait` / `review_list` · `phone_status` · `phone_screenshot` · `reel_job` (Edits → composer → review gate → share at time, normal/trial) · `job_status` · `queue_list` · `job_cancel`

## Running it by hand

```sh
.venv/bin/python -m autoedit serve            # foreground server on :4747
.venv/bin/python -m autoedit status           # same as setup_status
.venv/bin/python -m autoedit mcpb             # rebuild ~/AutoEdit/auto-edit.mcpb
tests/mcp_call.py speech_spans '{"path":"~/Reels/x/take.MOV"}'   # call any tool from a shell
```

Data lives in `~/AutoEdit` (projects, review items, jobs, formats, post log). Per-project outputs go to `<your folder>/auto-edit/{overlays,exports,finished}`.

## Phone Farm iOS (the bridge)

## Documentation

- [docs/getting-started.md](docs/getting-started.md) — install, configure, run, register a device
- [docs/architecture.md](docs/architecture.md) — the four processes, data stores, task model, source map
- [docs/plugins.md](docs/plugins.md) — write a plugin: tasks, execution context, versioning, panels, routes
- [docs/coordinates.md](docs/coordinates.md) — tap-layout profiles and how to add one
- [PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md) — plugin trust and compatibility rules
- [SECURITY.md](SECURITY.md) — before exposing the dashboard beyond loopback

## Claude + Jev video editing

The dashboard includes an Edits workspace and a local recipe runner. Claude can
submit a batch through the per-phone queue, with Jev checking editor state at
explicit checkpoints. See [docs/claude-edits.md](docs/claude-edits.md) for key setup,
recipe operations, review checkpoints and the first supervised run.

## Run the standalone application

Requirements are Node 22+, PostgreSQL, Xcode, a signed real-device WebDriverAgent, and Appium's XCUITest driver.

```sh
npm install
cp .env.example .env
npm run appium:install-driver
npm run db:up
npm run db:migrate
npm run wda:prepare
```

Run these long-lived processes (wrap each in a `launchd` agent or systemd unit for an always-on host):

```sh
npm run appium
npm run wda:service
npm run worker
npm run web
```

TikTok and Instagram support are enabled by default. Set `PHONE_FARM_PLUGINS` to comma-separated ESM package names to add more task plugins. Set `PHONE_FARM_AUTH_PLUGIN` to an ESM authentication provider before binding `WEB_HOST` outside loopback; startup deliberately fails otherwise.

## Plugin contract

`src/plugin.ts` defines the stable interfaces. A plugin can provide versioned tasks, registration checks, device-page panels, namespaced HTTP routes, and declared WDA extensions. Task execution receives the exact device, that plugin's own per-device data, resolved assets, a temporary workspace, cancellation, durable logging, safe device primitives, and an observed subprocess runner.

See `PLUGIN_DEVELOPMENT.md` for compatibility and trust rules.

`src/example-plugin.ts` is a minimal open-app plugin. Production plugins should be separate packages and should never require changes to core routing or scheduler code.

## Repository policy

This repository uses GitHub-hosted CI only. Never connect production devices, Apple signing material, production databases, self-hosted runners, or deployment credentials to workflows triggered by pull requests. See `SECURITY.md`.

```sh
npm run check
```
