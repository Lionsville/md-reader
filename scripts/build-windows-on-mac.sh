#!/usr/bin/env bash
# Cross-build the Windows installer (NSIS, x64) on this Mac and sign it with Azure Trusted Signing.
#
#   scripts/build-windows-on-mac.sh            build (signed when Azure settings are present)
#   scripts/build-windows-on-mac.sh --unsigned build without signing
#   scripts/build-windows-on-mac.sh --arm64    build for Windows on ARM instead of x64
#
# One-time setup (see docs/SIGNING.md):
#   brew install nsis llvm
#   rustup target add x86_64-pc-windows-msvc
#   cargo install --locked cargo-xwin
#   brew install jsign            (signing; plus `az login` or an app registration secret)
# cargo-xwin downloads the Microsoft CRT + Windows SDK on first use (Microsoft's license applies).
#
# Signing settings come from ./signing.env (MDR_AZURE_ENDPOINT, MDR_AZURE_ACCOUNT, MDR_AZURE_PROFILE).
# Auth: an app registration (AZURE_TENANT_ID + AZURE_CLIENT_ID in signing.env, secret from
# $AZURE_CLIENT_SECRET or the keychain item "md-reader-azure-client-secret"), or else your own
# Azure CLI login (`az login`). Signing itself is done by scripts/sign-windows.sh (jsign).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
if [ -f signing.env ]; then set -a; . ./signing.env; set +a; fi

TARGET="x86_64-pc-windows-msvc"
SIGN=1
for arg in "$@"; do
  case "$arg" in
    --unsigned) SIGN=0 ;;
    --arm64) TARGET="aarch64-pc-windows-msvc" ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

for tool in makensis cargo-xwin clang-cl lld-link; do
  command -v "$tool" >/dev/null || { echo "missing '$tool' — see the one-time setup at the top of this script" >&2; exit 1; }
done
rustup target add "$TARGET" >/dev/null

EXTRA_CONFIG=()
if [ "$SIGN" = 1 ]; then
  for v in MDR_AZURE_ENDPOINT MDR_AZURE_ACCOUNT MDR_AZURE_PROFILE; do
    if [ -z "${!v:-}" ]; then echo "signing: $v is not set (signing.env) — use --unsigned to build without signing" >&2; exit 1; fi
  done
  command -v jsign >/dev/null || { echo "missing 'jsign' (brew install jsign)" >&2; exit 1; }
  if [ -n "${AZURE_CLIENT_ID:-}" ] && [ -n "${AZURE_TENANT_ID:-}" ]; then
    if [ -z "${AZURE_CLIENT_SECRET:-}" ]; then
      AZURE_CLIENT_SECRET="$(security find-generic-password -a md-reader -s md-reader-azure-client-secret -w 2>/dev/null)" || {
        echo "signing: no AZURE_CLIENT_SECRET and no keychain item 'md-reader-azure-client-secret'" >&2; exit 1; }
    fi
    export AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET
    AUTH="app registration $AZURE_CLIENT_ID"
  else
    unset AZURE_CLIENT_SECRET
    az account show >/dev/null 2>&1 || { echo "signing: run 'az login' first (or set an app registration in signing.env)" >&2; exit 1; }
    AUTH="Azure CLI login ($(az account show --query user.name -o tsv))"
  fi
  export MDR_AZURE_ENDPOINT MDR_AZURE_ACCOUNT MDR_AZURE_PROFILE
  # The bundler calls this for every binary it produces (app exe, uninstaller, installer).
  SIGN_JSON="{\"bundle\":{\"windows\":{\"signCommand\":{\"cmd\":\"bash\",\"args\":[\"$ROOT/scripts/sign-windows.sh\",\"%1\"]}}}}"
  EXTRA_CONFIG=(--config "$SIGN_JSON")
  echo "==> Signing with Azure Trusted Signing ($MDR_AZURE_ACCOUNT / $MDR_AZURE_PROFILE) as $AUTH"
else
  echo "==> Building UNSIGNED (SmartScreen will warn on other machines)"
fi

[ -d node_modules ] || npm ci
npm run vendor
npx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis "${EXTRA_CONFIG[@]}"

OUT="src-tauri/target/$TARGET/release/bundle/nsis"
echo
echo "==> Built:"
ls -lh "$OUT"/*.exe
if [ "$SIGN" = 1 ]; then
  for f in "$OUT"/*.exe; do jsign extract --format PEM "$f" >/dev/null 2>&1 && echo "    signed: $(basename "$f")" || echo "    NOT signed: $(basename "$f")"; done
fi
