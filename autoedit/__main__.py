"""CLI: python -m autoedit serve | status | mcpb | install-launchd"""
import json
import os
import subprocess
import sys
from pathlib import Path

from .config import HOME, PORT, REPO


def serve():
    import uvicorn
    from .server import app
    uvicorn.run(app(), host="127.0.0.1", port=PORT, log_level="warning")


def status():
    from .server import setup_status
    print(json.dumps(setup_status(), indent=1))


def mcpb():
    import zipfile
    out = HOME / "auto-edit.mcpb"; src = REPO / "mcpb-autoedit"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in src.rglob("*"):
            if p.is_file():
                z.write(p, str(p.relative_to(src)))
    print(out)


PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.auto-edit.server</string>
<key>ProgramArguments</key><array><string>{python}</string><string>-m</string><string>autoedit</string><string>serve</string></array>
<key>WorkingDirectory</key><string>{repo}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>{home}/logs/server.log</string><key>StandardErrorPath</key><string>{home}/logs/server.log</string>
</dict></plist>"""


def install_launchd():
    p = Path.home() / "Library/LaunchAgents/io.auto-edit.server.plist"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(PLIST.format(python=sys.executable, repo=REPO, home=HOME))
    subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
    r = subprocess.run(["launchctl", "load", "-w", str(p)], capture_output=True, text=True)
    print("launchd:", "loaded" if r.returncode == 0 else r.stderr.strip(), "→", f"http://127.0.0.1:{PORT}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    {"serve": serve, "status": status, "mcpb": mcpb, "install-launchd": install_launchd}.get(cmd, serve)()
