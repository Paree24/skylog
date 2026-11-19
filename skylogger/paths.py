"""Resolve bundled resources and the user-writable observations folder.

Works both from source and from a PyInstaller bundle (sys._MEIPASS).
"""
import os
import subprocess
import sys
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)

# read-only resources (catalog + web UI)
RES_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
STATIC = RES_ROOT / "static"
CATALOG = RES_ROOT / "data" / "catalog.json"


def _documents_dir() -> Path:
    if sys.platform.startswith("linux"):
        try:
            out = subprocess.run(["xdg-user-dir", "DOCUMENTS"], capture_output=True,
                                 text=True, timeout=2).stdout.strip()
            if out and Path(out) != Path.home():
                return Path(out)
        except (OSError, subprocess.SubprocessError):
            pass
    return Path.home() / "Documents"


def observations_dir() -> Path:
    """SKYLOG_DATA env var > ~/Documents/Skylog (packaged) > ./observations (source)."""
    if os.environ.get("SKYLOG_DATA"):
        return Path(os.environ["SKYLOG_DATA"]).expanduser()
    if FROZEN:
        return _documents_dir() / "Skylog"
    return RES_ROOT / "observations"


OBS_DIR = observations_dir()
LOG_FILE = OBS_DIR / "observations.json"
PLACES_FILE = OBS_DIR / "places.json"
SETTINGS_FILE = OBS_DIR / "settings.json"
