#!/usr/bin/env python3
"""Build a double-clickable, self-contained Skylog app with PyInstaller.

    python3 build.py

Creates an isolated build venv (.build-venv/), installs PyInstaller into it
(the only step that needs internet), and writes:

    dist/Skylog          (Linux / macOS single-file executable)
    dist/Skylog.exe      (Windows)

The result bundles Python, the star catalog and the UI; the target machine
needs nothing installed. Build on each OS you want to run on.
"""
import os
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".build-venv"
BIN = VENV / ("Scripts" if os.name == "nt" else "bin")
PY = BIN / ("python.exe" if os.name == "nt" else "python")


def run(*cmd):
    print("$", " ".join(map(str, cmd)))
    subprocess.check_call([str(c) for c in cmd], cwd=ROOT)


def main():
    if not PY.exists():
        print("Creating build environment…")
        venv.EnvBuilder(with_pip=True, clear=True).create(VENV)
    pkgs = ["pyinstaller"] + (["pillow"] if os.name == "nt" or sys.platform == "darwin" else [])
    run(PY, "-m", "pip", "install", "--quiet", "--upgrade", *pkgs)

    if not (ROOT / "data" / "catalog.json").exists():
        run(PY, "tools/build_catalog.py")
    if not (ROOT / "assets" / "skylog.png").exists():
        run(PY, "tools/make_icon.py")

    sep = os.pathsep
    run(PY, "-m", "PyInstaller", ROOT / "run.py",
        "--name", "Skylog",
        "--onefile",
        "--windowed",            # no console window on Windows/macOS
        "--noconfirm", "--clean",
        "--icon", ROOT / "assets" / "skylog.png",
        "--add-data", f"{ROOT / 'static'}{sep}static",
        "--add-data", f"{ROOT / 'data' / 'catalog.json'}{sep}data",
        "--distpath", ROOT / "dist", "--workpath", ROOT / "build", "--specpath", ROOT / "build")

    exe = ROOT / "dist" / ("Skylog.exe" if os.name == "nt" else "Skylog")
    if sys.platform == "darwin":
        exe = ROOT / "dist" / "Skylog.app"
    print(f"\n✦ Built {exe}")
    if sys.platform.startswith("linux"):
        print("  Double-click it in your file manager, or run ./install.sh to add a menu/desktop launcher.")


if __name__ == "__main__":
    main()
