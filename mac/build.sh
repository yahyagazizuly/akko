#!/bin/bash
# Builds "Akko.app" (universal: Apple Silicon + Intel) and a .dmg into mac/build.
# Needs only the Xcode command line tools. Usage: ./build.sh   (add --run to launch it after)
set -euo pipefail
cd "$(dirname "$0")"
ROOT=..
APP="build/Akko.app"
VERSION=$(node -p "require('$ROOT/core/package.json').version")

echo "→ core library"
(cd "$ROOT/core" && { [ -d node_modules ] || npm install --silent; } && npm run build --silent)

echo "→ compile (arm64 + x86_64)"
rm -rf build && mkdir -p build "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
for arch in arm64 x86_64; do
  swiftc -O -target $arch-apple-macos13.0 -o build/chelik-$arch Sources/*.swift
done
lipo -create build/chelik-arm64 build/chelik-x86_64 -output "$APP/Contents/MacOS/Akko"
rm build/chelik-*

echo "→ resources"
cp web/overlay.html web/bridge.js "$ROOT/core/dist/akko.global.js" "$APP/Contents/Resources/web/"
# The icons are checked in; redrawing them needs Pillow, which is optional (only Xcode CLT + Node are required).
python3 "$ROOT/scripts/icons.py" >/dev/null 2>&1 || echo "  (icons: Pillow not found, using the checked-in ones)"
cp "$ROOT/assets/trayTemplate.png" "$ROOT/assets/trayTemplate@2x.png" "$APP/Contents/Resources/"
ICONSET=build/icon.iconset && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/assets/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ROOT/assets/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" && rm -rf "$ICONSET"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Akko</string>
  <key>CFBundleDisplayName</key><string>Akko</string>
  <key>CFBundleIdentifier</key><string>dev.minichelik.mac</string>
  <key>CFBundleExecutable</key><string>Akko</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>
PLIST

# Sign with a real identity when there is one (CHELIK_SIGN, or the first Apple Development / Developer ID
# certificate in the keychain): macOS then knows it is the same app after every build, so Screen Recording
# stays allowed. Ad-hoc signing (no certificate) changes the app's identity on every build and macOS forgets
# the permission — and without it he cannot measure window edges.
SIGN="${CHELIK_SIGN:-$(security find-identity -v -p codesigning 2>/dev/null | awk '/Apple Development|Developer ID Application/ && !f {print $2; f=1}' || true)}"
if [[ -n "$SIGN" ]]; then
  echo "→ sign ($SIGN)"
  codesign --force --deep --sign "$SIGN" "$APP"
else
  echo "→ sign (ad-hoc: Screen Recording must be allowed again after each build)"
  codesign --force --deep --sign - "$APP"
fi

echo "→ dmg"
STAGE=build/dmg && mkdir -p "$STAGE" && cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Akko" -srcfolder "$STAGE" -ov -format UDZO "build/Akko-$VERSION.dmg" >/dev/null
rm -rf "$STAGE"

du -sh "$APP" "build/Akko-$VERSION.dmg"
if [[ "${1:-}" == "--run" ]]; then pkill -x "Akko" || true; open "$APP"; fi
