#!/usr/bin/env bash
# Install the built Skylog app for the current user (Linux):
#   - app      -> ~/.local/share/skylog/Skylog
#   - launcher -> application menu (add --desktop for a Desktop icon too)
# Usage: ./install.sh [--desktop]   (run ./build.py first)
#        ./install.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")"

APP_DIR="$HOME/.local/share/skylog"
MENU="$HOME/.local/share/applications/skylog.desktop"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
DESK="$DESKTOP_DIR/skylog.desktop"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$APP_DIR" "$MENU" "$DESK"
  echo "Skylog removed (your observations in ~/Documents/Skylog were kept)."
  exit 0
fi

[[ -x dist/Skylog ]] || { echo "dist/Skylog not found — run: python3 build.py"; exit 1; }

mkdir -p "$APP_DIR" "$(dirname "$MENU")"
install -m 755 dist/Skylog "$APP_DIR/Skylog"
install -m 644 assets/skylog.png "$APP_DIR/skylog.png"

cat > "$MENU" <<EOF
[Desktop Entry]
Type=Application
Name=Skylog
GenericName=Night Sky Observation Logger
Comment=Plan and log what you see in the night sky (works offline)
Exec="$APP_DIR/Skylog"
Icon=$APP_DIR/skylog.png
Terminal=false
Categories=Science;Astronomy;
Keywords=stars;constellations;astronomy;sky;observation;
StartupNotify=false
EOF
chmod 755 "$MENU"

WANT_DESK=0; [[ "${1:-}" == "--desktop" ]] && WANT_DESK=1
if [[ $WANT_DESK == 1 && -d "$DESKTOP_DIR" ]]; then
  install -m 755 "$MENU" "$DESK"
  # GNOME needs the launcher marked as trusted; KDE uses the executable bit
  command -v gio >/dev/null && gio set "$DESK" metadata::trusted true 2>/dev/null || true
fi
command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$MENU")" 2>/dev/null || true

echo "✦ Skylog installed."
echo "  • Application menu: Skylog"
[[ $WANT_DESK == 1 && -d "$DESKTOP_DIR" ]] && echo "  • Desktop icon:     $DESK"
echo "  • Observations:     ~/Documents/Skylog/"
