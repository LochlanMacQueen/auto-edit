# auto-edit setup (once)

If you installed the **auto-edit app** (the DMG), the editor, ffmpeg, whisper and this server are
already inside it — skip to step 3. Steps 1–2 are only for running the server on its own.

1. **Editor** — built into the auto-edit app. (Server-only installs: install Palmier Pro from
   https://github.com/palmier-io/palmier-pro/releases and keep it open; its MCP must answer on 127.0.0.1:19789.)
2. **Media tools** — built into the app. (Server-only: `brew install ffmpeg`; whisper comes with install.sh.)
   The first transcription downloads the speech model (~500 MB) — start early.
3. **iPhone** — latest iOS; Settings → Privacy & Security → Developer Mode → on (restart); plug in by USB;
   tap Trust This Computer; install Instagram Edits and Instagram, logged into the account you post from.
   Turn on a Focus / Do Not Disturb mode while auto-edit is driving the phone — notification banners can steal taps.
4. **Phone bridge (WebDriverAgent)** — needs Xcode (full app, latest) and your Apple ID in Xcode → Settings → Accounts.
   ```
   git clone https://github.com/LochlanMacQueen/auto-edit ~/auto-edit && cd ~/auto-edit
   npm install && npm run appium:install-driver && cp .env.example .env
   # in .env set IOS_PLATFORM_VERSION (the phone's iOS), XCODE_ORG_ID (your Team ID), WDA_BUNDLE_ID (any id you own)
   npm run db:up && npm run db:migrate && npm run wda:prepare     # must end with ** TEST BUILD SUCCEEDED **
   npm run appium      # keep running
   npm run wda:service # keep running
   ```
   `phone_status` → ready: true when it works.
5. **Connect your agent** — auto-edit window → Connect → Add to Claude Desktop (or the Claude Code command, or a ChatGPT tunnel).
