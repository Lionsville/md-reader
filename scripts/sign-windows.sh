#!/usr/bin/env bash
# Signs one Windows binary with Azure Trusted Signing using jsign (works on macOS/Linux).
# Called by the Tauri bundler as its signCommand (see build-windows-on-mac.sh) with the file as $1.
# Auth: AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET (app registration), or else the
# signed-in Azure CLI account (`az login`). Either needs the "Trusted Signing Certificate Profile
# Signer" role on the certificate profile. Timestamping is automatic for Trusted Signing.
set -euo pipefail
file="$1"
host="${MDR_AZURE_ENDPOINT#https://}"; host="${host%/}"
if [ -n "${AZURE_CLIENT_SECRET:-}" ]; then
  pass="${AZURE_TENANT_ID}|${AZURE_CLIENT_ID}|${AZURE_CLIENT_SECRET}"
else
  pass="$(az account get-access-token --resource https://codesigning.azure.net --query accessToken -o tsv)"
fi
jsign --storetype TRUSTEDSIGNING --keystore "$host" --storepass "$pass" \
  --alias "${MDR_AZURE_ACCOUNT}/${MDR_AZURE_PROFILE}" \
  --name "MD Reader" --url "https://lionsville.nl" \
  --replace "$file"
