import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UGC = REPO / "ugc"
if str(UGC) not in sys.path:
    sys.path.insert(0, str(UGC))
HOME = Path(os.environ.get("AUTOEDIT_HOME", Path.home() / "AutoEdit"))
for _d in ("projects", "review", "jobs", "logs", "tmp", "formats"):
    (HOME / _d).mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get("AUTOEDIT_PORT", "4747"))
PALMIER_URL = os.environ.get("AUTOEDIT_PALMIER", "http://127.0.0.1:19789/mcp")
WDA_URL = os.environ.get("AUTOEDIT_WDA", "http://127.0.0.1:8100")
WHISPER_MODEL = os.environ.get("AUTOEDIT_WHISPER", "mlx-community/whisper-small-mlx")
SETTINGS = HOME / "settings.json"


def settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_settings(d: dict) -> None:
    SETTINGS.write_text(json.dumps(d, indent=1))
