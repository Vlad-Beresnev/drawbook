#!/bin/sh
# Stops the Drawbook server and removes the LaunchAgent. Your drawings in
# ~/Drawings are not touched.
set -eu

LABEL="dev.drawbook.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Drawbook server stopped and removed. Drawings are still in ~/Drawings."
