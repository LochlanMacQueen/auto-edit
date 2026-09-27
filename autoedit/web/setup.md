# auto-edit setup (once)

1. **Palmier Pro** — install from https://github.com/palmier-io/palmier-pro/releases/latest/download/PalmierPro.dmg (macOS 26, Apple Silicon), open it, leave it open. Its MCP server must answer on 127.0.0.1:19789 (`setup_status` → palmier_pro: true).
2. **ffmpeg + whisper** — `brew install ffmpeg`; whisper (mlx-whisper) is installed into the auto-edit venv by install.sh. First transcription downloads the model (~500 MB) — start early.
3. **iPhone** — latest iOS; Settings → Privacy & Security → Developer Mode on (restart); USB; Trust This Computer; Instagram Edits and Instagram installed and logged in.
4. **Phone bridge (WebDriverAgent)** — today this still comes from the phone-farm dashboard in this repo (needs Xcode): `npm install && npm run appium:install-driver && cp .env.example .env` (set IOS_PLATFORM_VERSION, XCODE_ORG_ID, WDA_BUNDLE_ID) → `npm run wda:prepare` → keep `npm run wda:service` running. `phone_status` → ready: true. A signing flow that removes the Xcode requirement is planned.
5. **Connect the agent** — auto-edit window → Connect (Add to Claude Desktop / Claude Code command / ChatGPT tunnel). When the person says "set up the iPhone bridge", do step 4 for them end to end and confirm with phone_status.
