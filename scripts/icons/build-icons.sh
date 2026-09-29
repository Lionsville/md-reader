#!/usr/bin/env bash
# Regenerates every icon in src-tauri/icons from the SVG sources in this folder.
# macOS only (uses WebKit via `swift`, `iconutil` and `sips`).
#
#   icon.svg          full-bleed app icon       -> PNGs, Windows .ico (48 px and up), Linux
#   icon-macos.svg    macOS-grid app icon       -> icon.icns (32 px and up)
#   icon-small.svg    simplified app icon       -> 16/24/32 px frames of .ico and .icns
#   document.svg      markdown document icon    -> document.icns (macOS), document.ico (Windows)
#   dmg-background.svg                          -> dmg-background.png (660x400 DMG window)
#
# Usage: scripts/icons/build-icons.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/src-tauri/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

swiftc -O "$HERE/rasterize.swift" -o "$TMP/rasterize" 2>/dev/null
raster() { # svg out.png size
  "$TMP/rasterize" "$HERE/$1" "$2" "$3" >/dev/null
}

echo "Rasterizing SVG sources..."
raster icon.svg "$TMP/icon-1024.png" 1024
raster icon-macos.svg "$TMP/mac-1024.png" 1024
raster document.svg "$TMP/doc-1024.png" 1024
for s in 16 24 32; do raster icon-small.svg "$TMP/small-$s.png" "$s"; done
for s in 16 32 64 128 256 512; do raster document.svg "$TMP/doc-$s.png" "$s"; done
for s in 64 128 256 512; do raster icon-macos.svg "$TMP/mac-$s.png" "$s"; done
for s in 48 64 128 256; do raster icon.svg "$TMP/icon-$s.png" "$s"; done

echo "Running tauri icon..."
(cd "$ROOT" && npx --no-install tauri icon "$TMP/icon-1024.png" -o "$OUT" >/dev/null)
rm -rf "$OUT/android" "$OUT/ios"

# Small macOS frames: the simplified icon on the macOS grid (~824/1024 of the canvas), padded.
raster icon-small.svg "$TMP/small-13.png" 13
sips --padToHeightWidth 16 16 "$TMP/small-13.png" --out "$TMP/smallmac-16.png" >/dev/null
raster icon-small.svg "$TMP/small-26.png" 26
sips --padToHeightWidth 32 32 "$TMP/small-26.png" --out "$TMP/smallmac-32.png" >/dev/null

echo "Building icon.icns..."
IS="$TMP/icon.iconset"; mkdir "$IS"
cp "$TMP/smallmac-16.png" "$IS/icon_16x16.png"
cp "$TMP/smallmac-32.png" "$IS/icon_16x16@2x.png"
cp "$TMP/smallmac-32.png" "$IS/icon_32x32.png"
cp "$TMP/mac-64.png"      "$IS/icon_32x32@2x.png"
cp "$TMP/mac-128.png"     "$IS/icon_128x128.png"
cp "$TMP/mac-256.png"     "$IS/icon_128x128@2x.png"
cp "$TMP/mac-256.png"     "$IS/icon_256x256.png"
cp "$TMP/mac-512.png"     "$IS/icon_256x256@2x.png"
cp "$TMP/mac-512.png"     "$IS/icon_512x512.png"
cp "$TMP/mac-1024.png"    "$IS/icon_512x512@2x.png"
iconutil -c icns "$IS" -o "$OUT/icon.icns"

echo "Building document.icns..."
DS="$TMP/document.iconset"; mkdir "$DS"
cp "$TMP/doc-16.png"   "$DS/icon_16x16.png"
cp "$TMP/doc-32.png"   "$DS/icon_16x16@2x.png"
cp "$TMP/doc-32.png"   "$DS/icon_32x32.png"
cp "$TMP/doc-64.png"   "$DS/icon_32x32@2x.png"
cp "$TMP/doc-128.png"  "$DS/icon_128x128.png"
cp "$TMP/doc-256.png"  "$DS/icon_128x128@2x.png"
cp "$TMP/doc-256.png"  "$DS/icon_256x256.png"
cp "$TMP/doc-512.png"  "$DS/icon_256x256@2x.png"
cp "$TMP/doc-512.png"  "$DS/icon_512x512.png"
cp "$TMP/doc-1024.png" "$DS/icon_512x512@2x.png"
iconutil -c icns "$DS" -o "$OUT/document.icns"

echo "Building icon.ico and document.ico..."
python3 "$HERE/make_ico.py" "$OUT/icon.ico" \
  "$TMP/small-16.png" "$TMP/small-24.png" "$TMP/small-32.png" \
  "$TMP/icon-48.png" "$TMP/icon-64.png" "$TMP/icon-128.png" "$TMP/icon-256.png"
raster document.svg "$TMP/doc-24.png" 24
raster document.svg "$TMP/doc-48.png" 48
python3 "$HERE/make_ico.py" "$OUT/document.ico" \
  "$TMP/doc-16.png" "$TMP/doc-24.png" "$TMP/doc-32.png" "$TMP/doc-48.png" \
  "$TMP/doc-64.png" "$TMP/doc-128.png" "$TMP/doc-256.png"

echo "Rendering DMG background..."
raster dmg-background.svg "$OUT/dmg-background.png" 660x400

# The tray/32x32 PNG is used by Tauri at runtime on Windows/Linux: use the crisp small render.
cp "$TMP/small-32.png" "$OUT/32x32.png"

echo "Icons written to $OUT"
