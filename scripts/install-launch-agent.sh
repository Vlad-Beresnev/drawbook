#!/bin/sh
# Installs a LaunchAgent that starts the Drawbook server at login and restarts it
# if it crashes. Run again after moving the repo or changing your Node install.
set -eu

LABEL="dev.drawbook.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
# launchd starts programs with a minimal PATH, so pass opencode's full path (AI Drawer).
OPENCODE="$(command -v opencode || echo opencode)"
LOG="$HOME/Library/Logs/drawbook.log"
PORT="${DRAWBOOK_PORT:-4747}"

if [ ! -f "$APP_DIR/dist/index.html" ]; then
  echo "dist/ is missing. Run: npm run build" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP_DIR/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DRAWBOOK_PORT</key><string>$PORT</string>
    <key>OPENCODE_BIN</key><string>$OPENCODE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

# Reload if it is already running, so a new build is picked up. bootout returns
# before the old service is fully removed, and bootstrap fails (error 5) if it
# runs too early, so wait until launchd no longer knows the label.
SERVICE="gui/$(id -u)/$LABEL"
launchctl bootout "$SERVICE" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$SERVICE" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/api/drawings" >/dev/null 2>&1; then
    echo "Drawbook is running at http://127.0.0.1:$PORT"
    echo "Next: open that URL in Chrome, then ⋮ → Cast, save and share → Install page as app."
    exit 0
  fi
  sleep 0.5
done

echo "The server did not start. See $LOG" >&2
exit 1
