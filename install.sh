#!/bin/sh
# Drawbook installer for macOS and Linux. No npm needed:
#
#   curl -fsSL https://raw.githubusercontent.com/Vlad-Beresnev/drawbook/main/install.sh | sh
#
# It installs into ~/.drawbook: a private Node.js runtime, the app, and
# opencode 2 (for the AI Drawer) unless an opencode 2 is already installed.
# Then it starts Drawbook in the background at every login and opens it.
# Your drawings live in ~/Drawings and are never touched by updates.
# Run it again to update; run it with --uninstall to remove the app.
set -eu

REPO="Vlad-Beresnev/drawbook"
NODE_VERSION="22.23.0"     # tested with Drawbook
OPENCODE_VERSION="2.0.32"  # tested with Drawbook; opencode 1 does not work

HOME_DIR="${DRAWBOOK_HOME:-$HOME/.drawbook}"
PORT="${DRAWBOOK_PORT:-4747}"
APP_URL="${DRAWBOOK_APP_URL:-https://github.com/$REPO/releases/latest/download/drawbook.tar.gz}"
LABEL="${DRAWBOOK_SERVICE_NAME:-dev.drawbook.server}"
URL="http://127.0.0.1:$PORT"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is needed. Please install it and run this again."; }
# "opencode v2.0.32" / "v22.23.0" -> "2.0.32" / "22.23.0"
version_of() { "$1" --version 2>/dev/null | grep -o '[0-9][0-9.]*' | head -n 1 || true; }

need curl
need tar

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "This installer is for macOS and Linux. On Windows use install.ps1 (see the README)." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "Unsupported processor: $(uname -m)" ;;
esac
# An Intel shell on Apple Silicon (Rosetta) reports x86_64: use the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

service_file() {
  if [ "$os" = darwin ]; then echo "$HOME/Library/LaunchAgents/$LABEL.plist"; else echo "$HOME/.config/systemd/user/$LABEL.service"; fi
}

has_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

stop_service() {
  if [ "$os" = darwin ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    # bootout returns before the service is gone; bootstrap fails if it is too early.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
      sleep 0.5
    done
  elif has_systemd; then
    systemctl --user disable --now "$LABEL.service" 2>/dev/null || true
  fi
  if [ -f "$HOME_DIR/server.pid" ]; then
    kill "$(cat "$HOME_DIR/server.pid")" 2>/dev/null || true
    rm -f "$HOME_DIR/server.pid"
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_service
  rm -f "$(service_file)"
  if [ "$os" = linux ] && has_systemd; then systemctl --user daemon-reload; fi
  rm -rf "$HOME_DIR"
  say "Drawbook is removed. Your drawings are still in ~/Drawings."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$HOME_DIR"

# 1. Node.js runtime, private to Drawbook (your own Node, if any, is not touched).
node_bin="$HOME_DIR/node/bin/node"
if [ "$(version_of "$node_bin")" != "$NODE_VERSION" ]; then
  say "Downloading Node.js ${NODE_VERSION}..."
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$os-$arch.tar.gz" -o "$tmp/node.tar.gz"
  rm -rf "$HOME_DIR/node"
  mkdir -p "$HOME_DIR/node"
  tar -xzf "$tmp/node.tar.gz" -C "$HOME_DIR/node" --strip-components 1
fi

# 2. The app (already built: no npm install).
say "Downloading Drawbook..."
curl -fsSL "$APP_URL" -o "$tmp/drawbook.tar.gz"
mkdir -p "$tmp/app"
tar -xzf "$tmp/drawbook.tar.gz" -C "$tmp/app" --strip-components 1
[ -f "$tmp/app/server/index.js" ] && [ -f "$tmp/app/dist/index.html" ] || fail "The download is not a Drawbook release."
stop_service
rm -rf "$HOME_DIR/app"
mv "$tmp/app" "$HOME_DIR/app"

# 3. opencode 2 for the AI Drawer. An opencode 2 you already have is used as is.
if command -v opencode >/dev/null 2>&1 && version_of opencode | grep -q '^2\.'; then
  opencode_bin="$(command -v opencode)"
  say "Using your opencode $(version_of opencode)."
else
  opencode_bin="$HOME_DIR/opencode/opencode"
  if [ "$(version_of "$opencode_bin")" != "$OPENCODE_VERSION" ]; then
    target="$os-$arch"
    if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then target="$target-musl"; fi
    say "Downloading opencode ${OPENCODE_VERSION}..."
    curl -fsSL "https://registry.npmjs.org/@opencode/cli-$target/-/cli-$target-$OPENCODE_VERSION.tgz" -o "$tmp/opencode.tgz"
    mkdir -p "$tmp/opencode" "$HOME_DIR/opencode"
    tar -xzf "$tmp/opencode.tgz" -C "$tmp/opencode"
    mv "$tmp/opencode/package/bin/opencode" "$opencode_bin"
    chmod 755 "$opencode_bin"
  fi
fi

# 4. Start in the background now and at every login.
server="$HOME_DIR/app/server/index.js"
file="$(service_file)"
if [ "$os" = darwin ]; then
  mkdir -p "$(dirname "$file")" "$HOME/Library/Logs"
  log="$HOME/Library/Logs/drawbook.log"
  cat >"$file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$node_bin</string><string>$server</string></array>
  <key>WorkingDirectory</key><string>$HOME_DIR/app</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DRAWBOOK_PORT</key><string>$PORT</string>
    <key>OPENCODE_BIN</key><string>$opencode_bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$file"
elif has_systemd; then
  log="journalctl --user -u $LABEL"
  mkdir -p "$(dirname "$file")"
  cat >"$file" <<EOF
[Unit]
Description=Drawbook (local Excalidraw app)

[Service]
ExecStart=$node_bin $server
WorkingDirectory=$HOME_DIR/app
Environment=DRAWBOOK_PORT=$PORT
Environment=OPENCODE_BIN=$opencode_bin
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$LABEL.service"
else
  # No systemd user session (e.g. a container): run it now; it will not start at login.
  log="$HOME_DIR/drawbook.log"
  DRAWBOOK_PORT="$PORT" OPENCODE_BIN="$opencode_bin" nohup "$node_bin" "$server" >"$log" 2>&1 &
  echo $! >"$HOME_DIR/server.pid"
  say "Note: no systemd user session, so Drawbook will not start at login. Run this installer again to start it."
fi

for _ in $(seq 1 40); do
  curl -fsS "$URL/api/drawings" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$URL/api/drawings" >/dev/null 2>&1 || fail "Drawbook did not start. See: $log"

say "Drawbook is running at $URL"
echo "  Drawings: ~/Drawings    Logs: $log"
echo "  Make it an app: open $URL in Chrome, then ⋮ → Cast, save and share → Install page as app."
echo "  Use your ChatGPT plan in the AI Drawer: $opencode_bin auth login openai"
if [ -z "${DRAWBOOK_NO_OPEN:-}" ]; then
  if [ "$os" = darwin ]; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
fi
