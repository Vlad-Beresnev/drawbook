#!/bin/sh
# Packs a built Drawbook (dist/ + server/) into release/drawbook.tar.gz and
# release/drawbook.zip, the files the installers download. Run after
# `npm run build`. The server needs no npm packages, only Node.js.
set -eu
cd "$(dirname "$0")/.."
[ -f dist/index.html ] || { echo "dist/ is missing. Run: npm run build" >&2; exit 1; }
rm -rf release
mkdir -p release/drawbook
cp -R dist server package.json README.md release/drawbook/
COPYFILE_DISABLE=1 tar --no-xattrs -czf release/drawbook.tar.gz -C release drawbook
if command -v zip >/dev/null 2>&1; then (cd release && zip -qr drawbook.zip drawbook); fi
rm -rf release/drawbook
ls -l release
