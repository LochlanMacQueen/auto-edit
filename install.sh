#!/bin/bash
# auto-edit installer (macOS, Apple Silicon). Usage: curl -fsSL https://raw.githubusercontent.com/LochlanMacQueen/auto-edit/main/install.sh | bash
set -euo pipefail
DIR="${AUTOEDIT_DIR:-$HOME/auto-edit}"
say(){ printf "\033[1m▸ %s\033[0m\n" "$1"; }
command -v brew >/dev/null || { say "Installing Homebrew"; /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; eval "$(/opt/homebrew/bin/brew shellenv)"; }
for f in ffmpeg python@3.12 node; do brew list "$f" >/dev/null 2>&1 || { say "brew install $f"; brew install "$f"; }; done
if [ -d "$DIR/.git" ]; then say "Updating $DIR"; git -C "$DIR" pull -q --ff-only || true; else say "Cloning into $DIR"; git clone -q https://github.com/LochlanMacQueen/auto-edit.git "$DIR"; fi
cd "$DIR"
PY="$(brew --prefix python@3.12)/bin/python3.12"
[ -x .venv/bin/python ] || { say "Creating Python environment"; "$PY" -m venv .venv; }
say "Installing Python packages (whisper model downloads on first use)"
.venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -r requirements-autoedit.txt
say "Installing the background server (launchd) and building the Claude Desktop extension"
.venv/bin/python -m autoedit install-launchd
.venv/bin/python -m autoedit mcpb >/dev/null
sleep 2
say "Done. Opening the dashboard."
open "http://127.0.0.1:4747" || true
cat <<MSG

Next:
  1. Dashboard → Connect → add auto-edit to Claude Desktop (double-click ~/AutoEdit/auto-edit.mcpb) or Claude Code.
  2. Install Palmier Pro and keep it open:  https://github.com/palmier-io/palmier-pro/releases/latest/download/PalmierPro.dmg
  3. In Claude: "Run setup_status and walk me through anything that isn't ready."
MSG
