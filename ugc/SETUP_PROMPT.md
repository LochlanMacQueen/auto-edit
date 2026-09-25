# Setup prompt — get this Mac, this iPhone and this repo ready for the reel pipeline

You are setting up a person's machine so the UGC reel pipeline in this repo works. Walk
them through it **one step at a time**: do every terminal step yourself, tell them exactly
what to click for the steps that need their hands (App Store, Apple ID, the phone), and
wait for them to confirm before moving on. Don't dump the whole list at once. Don't skip
the verification at the end. When everything passes, tell them to go back to the Setup
guide in the dashboard and continue from step 2.

Start by running `bash ugc/check_setup.sh` from the repo root and reading what it says.
Work through the ✗ lines in this order; skip anything that already passes.

## 1. Xcode (full app, latest version)

- They need the **full Xcode from the App Store** (Command Line Tools alone are not enough),
  updated to the latest version, opened once. Ask them to do that; it takes a while.
- Then you run: `sudo xcodebuild -license accept`,
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`, `xcodebuild -runFirstLaunch`.
  `xcode-select -p` must print a path inside Xcode.app.
- Ask them to add their Apple ID in Xcode → Settings → Accounts and read you the
  10-character **Team ID**. A free personal team is fine for one phone.

## 2. The iPhone

- Latest iOS installed. Settings → Privacy & Security → **Developer Mode** on → restart →
  confirm. (If the toggle isn't there, it appears after the first pairing with Xcode.)
- Plug in by USB, unlock, tap **Trust This Computer**. In Xcode → Window → Devices and
  Simulators it should say "Connected" after a minute.
- **Instagram Edits** and **Instagram** installed and logged into the account they post from.
- Verify: `xcrun xctrace list devices` lists the phone under "Devices", not "Devices Offline".

## 3. Palmier Pro and the media tools

- **Palmier Pro** installed and open, with its MCP server turned on (it listens on
  `127.0.0.1:19789`). Ask them to open it now and leave it open.
- You run: `brew install ffmpeg` (install Homebrew first if missing) and
  `pip3 install -r ugc/requirements.txt` (mlx-whisper). Start a first transcription in the
  background so the model downloads now, not during their first video.
- Verify: `python3 ugc/palmier_mcp.py list` prints Palmier's tools.

## 4. This dashboard (the bridge to the phone)

Follow `docs/getting-started.md`; the short form, all run by you from the repo root:

```sh
npm install
npm run appium:install-driver
cp .env.example .env        # then set IOS_PLATFORM_VERSION (the phone's iOS), XCODE_ORG_ID (their Team ID), WDA_BUNDLE_ID (any id they control), POSTGRES_PASSWORD
npm run db:up && npm run db:migrate
npm run wda:prepare         # must end with ** TEST BUILD SUCCEEDED ** — needs a graphical login session, not plain SSH
```

Then start the four long-lived processes (four terminals, or a `launchd` agent each):
`npm run appium`, `npm run wda:service`, `npm run worker`, `npm run web`.

Open <http://127.0.0.1:3000>, click **Add device**, and have them step through the
wizard (unlock the phone when WebDriverAgent first launches). Done when the device card
shows a live screen.

## 5. Claude itself

They should use Claude Code (or the Claude desktop app's Code tab) **with this repo's
folder attached** for every session. Make sure it's installed and signed in.

## 6. Verify

`bash ugc/check_setup.sh` must be all ✓. Then say: "Setup is done — go back to the Setup
guide in the dashboard and continue from step 2 (put your footage in a folder)."
