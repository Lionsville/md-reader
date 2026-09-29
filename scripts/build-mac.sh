#!/usr/bin/env bash
# Build MD Reader for macOS: .app + .dmg, universal (Apple Silicon + Intel) by default.
#
#   scripts/build-mac.sh              universal build
#   scripts/build-mac.sh --native     only this Mac's architecture (faster)
#   scripts/build-mac.sh --no-dmg     only the .app
#
# Signing / notarization is switched on purely by environment variables (see docs/SIGNING.md):
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: <Name> (<TEAMID>)" from your keychain
#     (or APPLE_CERTIFICATE = base64 .p12 + APPLE_CERTIFICATE_PASSWORD to use a temp keychain)
#   notarize with an App Store Connect API key:  APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
#   ...or with an Apple ID:                      APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID
# Without an identity the app is ad-hoc signed: fine on this Mac, blocked by Gatekeeper elsewhere.
# Locally these are read from ./signing.env (git-ignored; see signing.env.example).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f signing.env ]; then set -a; . ./signing.env; set +a; fi
[ -d /opt/homebrew/opt/rustup/bin ] && export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

TARGET="universal-apple-darwin"
BUNDLES="app,dmg"
for arg in "$@"; do
  case "$arg" in
    --native) TARGET="" ;;
    --no-dmg) BUNDLES="app" ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# A key path without a key id (template default) means: no API-key notarization.
if [ -z "${APPLE_API_KEY:-}" ]; then unset APPLE_API_KEY_PATH APPLE_API_ISSUER; fi
# The Tauri bundler treats set-but-empty variables as configured: drop empty ones.
for v in APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD \
         APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH; do
  if [ -z "${!v:-}" ]; then unset "$v"; fi
done

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ] && [ -z "${APPLE_CERTIFICATE:-}" ]; then
  export APPLE_SIGNING_IDENTITY="-"
  echo "==> No signing identity: ad-hoc signing (not distributable)."
  NOTARIZE=0
elif [ -n "${APPLE_API_KEY:-}" ] || [ -n "${APPLE_ID:-}" ]; then
  echo "==> Signing as '${APPLE_SIGNING_IDENTITY:-<from APPLE_CERTIFICATE>}' and notarizing."
  NOTARIZE=1
else
  echo "==> Signing as '${APPLE_SIGNING_IDENTITY:-<from APPLE_CERTIFICATE>}' WITHOUT notarization."
  NOTARIZE=0
fi

if [ -n "$TARGET" ] && command -v rustup >/dev/null; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
fi
[ -d node_modules ] || npm ci
npm run vendor

npx tauri build ${TARGET:+--target "$TARGET"} --bundles "$BUNDLES"

OUT="src-tauri/target/${TARGET:+$TARGET/}release/bundle"
APP="$OUT/macos/MD Reader.app"
echo
echo "==> Built:"
du -sh "$APP" "$OUT"/dmg/*.dmg 2>/dev/null || true
lipo -archs "$APP/Contents/MacOS/md-reader" | sed 's/^/    architectures: /'
codesign --verify --deep --strict "$APP" && echo "    codesign: valid"
if [ "$NOTARIZE" = 1 ]; then
  xcrun stapler validate "$APP"
  spctl --assess --type execute -vv "$APP"
  # Tauri notarizes + staples the .app; also sign, notarize and staple the DMG itself so it
  # passes Gatekeeper offline and doesn't show a "downloaded from the internet" warning.
  for DMG in "$OUT"/dmg/*.dmg; do
    [ -f "$DMG" ] || continue
    echo "==> Notarizing $(basename "$DMG")"
    codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
    if [ -n "${APPLE_API_KEY:-}" ]; then
      xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
    else
      xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
    fi
    xcrun stapler staple "$DMG"
    spctl --assess --type open --context context:primary-signature -vv "$DMG"
  done
fi
