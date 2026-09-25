# auto-edit

Raw talking-head takes in, finished captioned reels posted from your iPhone out — edited by Claude in Palmier Pro and Instagram Edits, in your format, every time. Built on Phone Farm iOS.

An open-source, standalone application for operating physical iOS devices and running scheduled TikTok and Instagram workflows. It includes guided device registration, WDA/Appium supervision, live video and remote input, PostgreSQL-backed scheduling, recurring jobs, uploads, execution history, the dashboard/API server, and built-in TikTok + Instagram automation plugins.

It runs locally as-is; authentication is optional on a loopback bind. Harden it for a shared or exposed deployment by supplying your own `AuthProvider` (`PHONE_FARM_AUTH_PLUGIN`) and process supervision — no fork required. Tasks are persisted as `pluginId`, `taskType`, `taskVersion`, and a JSON payload, so an old schedule can never silently execute a new contract.

> Live demo and setup walkthrough: **[gethandler.ai/ios-farm](https://gethandler.ai/ios-farm)**

## Make reels with Claude (Palmier Pro → iPhone → Instagram Edits → Instagram)

This fork adds a repeatable UGC pipeline: raw talking-head takes in, finished captioned
reels posted from a real iPhone out, in your format. Claude does the operating.

1. Run the dashboard (below) and open <http://127.0.0.1:3000>. The **Setup guide** opens on
   first launch. Step 1 hands you [`ugc/SETUP_PROMPT.md`](ugc/SETUP_PROMPT.md) — paste it into
   Claude Code with this repo attached and Claude sets up Xcode, the phone, Palmier Pro and
   this dashboard with you.
2. Put your takes, images and song in a folder. Paste [`ugc/AGENT_PROMPT.md`](ugc/AGENT_PROMPT.md)
   into Claude and tell it exactly what you want.
3. Review the video Claude hands back (sound is baked in from Palmier); iterate until right.
4. Send it to Instagram Edits — tell Claude the on-screen text; it will pause and ask specifics.
5. Have it post. Every video after the first is one command.

Everything for this lives in [`ugc/`](ugc/README.md).

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
