#!/bin/bash
# Verifies the machine, the phone bridge and the editor for the UGC pipeline.
ok(){ printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=1; }
FAIL=0
echo "Mac"
xcode-select -p 2>/dev/null | grep -q "Xcode.app" && ok "Xcode selected ($(xcodebuild -version 2>/dev/null | head -1))" || bad "xcode-select does not point at Xcode.app — install full Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
command -v ffmpeg >/dev/null && ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')" || bad "ffmpeg missing — brew install ffmpeg"
command -v python3 >/dev/null && ok "python3 $(python3 --version 2>&1 | awk '{print $2}')" || bad "python3 missing"
python3 -c "import mlx_whisper" 2>/dev/null && ok "mlx-whisper importable" || bad "mlx-whisper missing — pip3 install -r ugc/requirements.txt"
command -v node >/dev/null && ok "node $(node --version)" || bad "node missing (22+)"
echo "iPhone"
DEV=$(xcrun xctrace list devices 2>/dev/null | awk '/^== Devices ==/{f=1;next} /^== /{f=0} f && /iPhone/ && !/Simulator/' | head -1)
[ -n "$DEV" ] && ok "Xcode sees: $DEV" || bad "no iPhone under 'Devices' in xcrun xctrace list devices — plug in, trust, Developer Mode on"
curl -s --max-time 3 http://127.0.0.1:8100/status | grep -q '"ready"' && ok "WebDriverAgent answering on :8100" || bad "WebDriverAgent not on :8100 — register the device in the dashboard (Add device) and keep npm run wda:service running"
echo "Editor"
curl -s --max-time 3 -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:19789/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' | grep -qE '^(200|201|202)$' && ok "Palmier Pro MCP on :19789" || bad "Palmier Pro MCP not answering on 127.0.0.1:19789 — open Palmier Pro and turn on its MCP server"
echo "Dashboard"
curl -s --max-time 3 http://127.0.0.1:3000/health | grep -q '"ok":true' && ok "dashboard on :3000" || bad "dashboard not on :3000 — npm run web"
echo
[ $FAIL = 0 ] && echo "All good. Paste ugc/AGENT_PROMPT.md into Claude." || echo "Fix the ✗ lines, then run again."
exit $FAIL
