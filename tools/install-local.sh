#!/bin/bash
# Build HTTP Mac Menu for this Mac, install it into /Applications and relaunch it.
#
# Usage: npm run install:local
#
# Also unregisters the Electron helper bundles from LaunchServices; otherwise
# Spotlight on recent macOS lists "HTTP Mac Menu Helper (GPU)" etc. as apps.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="HTTP Mac Menu"
TARGET="/Applications/$APP_NAME.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

case "$(uname -m)" in
  arm64) ARCH_FLAG=--arm64; BUILD_DIR=dist/mac-arm64 ;;
  x86_64) ARCH_FLAG=--x64; BUILD_DIR=dist/mac ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
BUILT="$BUILD_DIR/$APP_NAME.app"

echo "▸ Building $APP_NAME ($ARCH_FLAG)…"
npm run --silent build:css
npx electron-builder --dir "$ARCH_FLAG"

if [[ ! -d "$BUILT" ]]; then
  echo "Build output not found at $BUILT" >&2
  exit 1
fi

echo "▸ Quitting running copy (if any)…"
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
for _ in 1 2 3 4 5; do
  pgrep -f "$APP_NAME.app/Contents/MacOS" >/dev/null || break
  sleep 1
done
pkill -f "$APP_NAME.app/Contents/MacOS" >/dev/null 2>&1 || true

echo "▸ Installing to $TARGET…"
rm -rf "$TARGET"
ditto "$BUILT" "$TARGET"
codesign --verify --deep --strict "$TARGET"

echo "▸ Tidying LaunchServices registrations…"
# The dev build must not show up in Spotlight as a second copy of the app.
"$LSREGISTER" -u "$PWD/$BUILT" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$TARGET" >/dev/null 2>&1 || true
for helper in "$TARGET/Contents/Frameworks/$APP_NAME Helper"*.app; do
  "$LSREGISTER" -u "$helper" >/dev/null 2>&1 || true
done

echo "▸ Launching…"
open -a "$TARGET"
echo "Installed $APP_NAME $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$TARGET/Contents/Info.plist") to $TARGET"
