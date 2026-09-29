# Code signing & notarization

**Chosen setup:** signed release builds are produced **locally on the Mac**:

| | How | Script |
|---|---|---|
| macOS | Developer ID Application: Lionsville B.V. (F25LRF5P7Y) from the login keychain; notarized with an **App Store Connect API key**; app *and* DMG stapled | `scripts/build-mac.sh` |
| Windows | NSIS installer **cross-compiled on the Mac** (cargo-xwin + LLVM + NSIS), signed with **Azure Trusted Signing** via [jsign](https://ebourg.github.io/jsign/) (`scripts/sign-windows.sh`) | `scripts/build-windows-on-mac.sh` |

Settings live in `signing.env` (git-ignored; copy `signing.env.example`). Only identifiers and paths go
there — the Azure client secret is kept in the macOS keychain, the `.p8` key in
`~/.appstoreconnect/private_keys/`.

### One-time setup

```bash
cp signing.env.example signing.env        # then fill in the IDs
# App Store Connect API key (role: Developer) → save the downloaded file as:
mkdir -p ~/.appstoreconnect/private_keys && mv ~/Downloads/AuthKey_<KEYID>.p8 ~/.appstoreconnect/private_keys/
# Windows cross-build + signing toolchain:
brew install nsis llvm jsign
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
# Azure auth — either sign in as yourself:
az login
# ...or use an app registration (fill AZURE_TENANT_ID/AZURE_CLIENT_ID in signing.env) and store its secret:
security add-generic-password -U -a md-reader -s md-reader-azure-client-secret -w
```

The account used (your own or the app registration) needs the **Trusted Signing Certificate Profile Signer** role on the
certificate profile (Azure portal › your Trusted Signing account › Access control (IAM)).

### Building a release

```bash
scripts/build-mac.sh                 # universal .app + .dmg, signed, notarized, stapled
scripts/build-windows-on-mac.sh      # x64 NSIS installer, signed (add --arm64 for Windows on ARM)
```

Output: `src-tauri/target/universal-apple-darwin/release/bundle/{macos,dmg}/` and
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

The sections below are the general reference (CI and the other Windows options) kept for later.

## Reference: what each option needs

**macOS** (Apple Developer Program membership — you have one):

1. A **Developer ID Application** certificate (not "Apple Development" / "Mac App Distribution").
   Xcode › Settings › Accounts › Manage Certificates › **+** › *Developer ID Application*, or
   developer.apple.com › Certificates. Export it from Keychain Access as a `.p12` with a password.
2. The exact identity name, e.g. `Developer ID Application: Lionsville B.V. (ABCDE12345)`
   (`security find-identity -v -p codesigning`).
3. Notarization credentials — **one** of:
   - **App Store Connect API key (recommended):** App Store Connect › Users and Access ›
     Integrations › Team Keys › **+** (role *Developer*). We need the **Key ID**, the **Issuer ID**
     and the downloaded **`AuthKey_<KeyID>.p8`** (can only be downloaded once).
   - **Apple ID:** the Apple ID e-mail, an **app-specific password** (appleid.apple.com › Sign-In
     and Security › App-Specific Passwords) and the **Team ID**.

**Windows** — tell us what kind of certificate you have, then provide the matching items:

| Your certificate | What we need |
|---|---|
| **OV certificate as a `.pfx` file** (only possible for certificates issued before June 2023) | the `.pfx` + its password |
| **EV or OV certificate on a USB token** (SafeNet/YubiKey…) | nothing for CI — it can only sign on a machine with the token plugged in (local build with `-CertificateThumbprint`, or a self-hosted runner). We need the certificate **SHA-1 thumbprint** |
| **Cloud signing from your CA** (SSL.com eSigner, DigiCert KeyLocker, Sectigo, Certum SimplySign, GlobalSign Atlas…) | provider name + the credentials its CLI needs (e.g. eSigner: username, password, credential ID, TOTP secret) |
| **Azure Trusted Signing** (Microsoft's service, ~$10/month, no hardware) | Azure endpoint, account name, certificate profile name, and an app registration: tenant ID, client ID, client secret |

Also confirm the **publisher name** as it appears on the certificate — it should match
`bundle.publisher` in `src-tauri/tauri.conf.json` (currently the placeholder `Lionsville`).

## macOS

Tauri signs every binary with the hardened runtime (`bundle.macOS.hardenedRuntime: true`),
then notarizes and staples the `.app`, and builds the `.dmg` from it. No entitlements are needed:
MD Reader is not sandboxed, and WKWebView's JIT runs in WebKit's own (Apple-signed) processes, so
the app doesn't need `com.apple.security.cs.allow-jit`. If a future feature needs one, add an
`Entitlements.plist` and set `bundle.macOS.entitlements`.

### Local

```sh
# 1. Signing identity from your login keychain (after importing the .p12 by double-clicking it)
export APPLE_SIGNING_IDENTITY="Developer ID Application: Lionsville B.V. (ABCDE12345)"

# 2a. Notarize with an App Store Connect API key (recommended) ...
export APPLE_API_KEY=ABC123DEFG               # Key ID
export APPLE_API_ISSUER=69a6de7e-...-...      # Issuer ID
export APPLE_API_KEY_PATH=~/private_keys/AuthKey_ABC123DEFG.p8
# 2b. ... or with an Apple ID
# export APPLE_ID=you@example.com APPLE_PASSWORD=abcd-efgh-ijkl-mnop APPLE_TEAM_ID=ABCDE12345

scripts/build-mac.sh            # universal .app + .dmg, signed, notarized, stapled
```

`scripts/build-mac.sh` is a thin wrapper around
`npx tauri build --target universal-apple-darwin --bundles app,dmg` that drops empty variables
(Tauri treats a *set but empty* variable as configured) and verifies the result. Without
`APPLE_SIGNING_IDENTITY` it signs ad-hoc (`-`), which runs on your own Mac only.

Instead of a keychain identity you can also pass the certificate itself (this is what CI does):
`APPLE_CERTIFICATE` = `base64 -i cert.p12 | pbcopy`, `APPLE_CERTIFICATE_PASSWORD` = its password;
Tauri then imports it into a temporary keychain.

Universal builds need both Rust targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

### CI (GitHub Actions, `.github/workflows/release.yml`)

Add these **repository secrets** (Settings › Secrets and variables › Actions):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i DeveloperID.p12` output |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | API-key notarization: Key ID, Issuer ID, full text of the `.p8` file |
| *or* `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple-ID notarization |

With no secrets the workflow still succeeds and produces an ad-hoc signed, un-notarized build.
If both notarization variants are configured, the API key wins.

## Windows

Tauri signs `md-reader.exe`, the uninstaller and the NSIS setup `.exe`. Relevant config
(`src-tauri/tauri.conf.json › bundle.windows`): `digestAlgorithm: "sha256"`,
`timestampUrl: "http://timestamp.digicert.com"` (works for any CA's certificate — change it to
your CA's server if you prefer; set `tsp: true` if your CA requires RFC 3161), and
`certificateThumbprint` / `signCommand` left unset — they are supplied at build time.

### The options

1. **`.pfx` file + signtool** — simplest, but since June 2023 CAs may no longer issue code-signing
   keys outside a hardware module, so this only applies to older certificates.
2. **USB token (EV/OV)** — signtool with `certificateThumbprint`; the token must be plugged in
   and unlocked, so it's local builds (or a self-hosted runner) only. EV certificates on tokens no
   longer get instant SmartScreen reputation (Microsoft dropped that in 2024), so for SmartScreen
   an EV certificate behaves like an OV one.
3. **Cloud/HSM signing via `signCommand`** — the CA's signing CLI is called for every file
   (`%1` = file path). Works in CI. Examples:
   - SSL.com eSigner: `CodeSignTool.bat sign -username=… -password=… -credential_id=… -totp_secret=… -input_file_path=%1 -override`
   - DigiCert KeyLocker: `smctl sign --keypair-alias=… --input %1`
4. **Azure Trusted Signing** — Microsoft-run, cheap, CI-friendly; uses
   [`trusted-signing-cli`](https://github.com/Levminer/trusted-signing-cli) as `signCommand`:
   `trusted-signing-cli -e https://weu.codesigning.azure.net -a <account> -c <profile> -d "MD Reader" %1`
   with `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` in the environment.
   (Check current eligibility: at launch it was limited to organisations with a multi-year
   verifiable business history in a limited set of countries.)

### Local (on Windows)

```powershell
.\scripts\build-windows.ps1                                     # unsigned
.\scripts\build-windows.ps1 -CertificateThumbprint 0123…4567    # cert store / USB token (needs signtool on PATH)
.\scripts\build-windows.ps1 -SignCommand 'trusted-signing-cli -e https://weu.codesigning.azure.net -a ACCOUNT -c PROFILE -d "MD Reader" %1'
.\scripts\build-windows.ps1 -Arch arm64                         # ARM64 installer
```

The script writes a temporary `src-tauri/tauri.signing.conf.json` and passes it with
`tauri build --config …`, so the committed config never contains machine-specific values.
Equivalent by hand: `npx tauri build --config '{"bundle":{"windows":{"certificateThumbprint":"…"}}}'`.

To import a `.pfx` into the store: `Import-PfxCertificate -FilePath cert.pfx -CertStoreLocation Cert:\CurrentUser\My -Password (Read-Host -AsSecureString)`,
then use its thumbprint.

### CI (GitHub Actions)

Set the repository **variable** `WINDOWS_SIGNING` to choose — this is the "TODO switch":

| `WINDOWS_SIGNING` | Also set |
|---|---|
| *(unset)* or `none` | – (unsigned installer) |
| `pfx` | secrets `WINDOWS_CERTIFICATE` (`base64` of the `.pfx`), `WINDOWS_CERTIFICATE_PASSWORD` |
| `azure` | secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`; variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` |
| `command` | variable `WINDOWS_SIGN_COMMAND` (with `%1`); credentials as secrets `WINDOWS_SIGN_ENV_USERNAME`, `…_PASSWORD`, `…_TOTP_SECRET`, `…_CREDENTIAL_ID`, available to the command as environment variables. The signer's CLI must also be installed — add an install step for it in `release.yml` (marked `TODO(signing)`) |

Set variable `BUILD_WINDOWS_ARM64=true` (or tick the box when running the workflow manually) to
also build an ARM64 installer.

## Verifying a signed build

```sh
# macOS
codesign --verify --deep --strict --verbose=2 "MD Reader.app"
spctl --assess --type execute -vv "MD Reader.app"     # "source=Notarized Developer ID"
xcrun stapler validate "MD Reader.app"
spctl --assess --type open --context context:primary-signature -vv "MD Reader_x.y.z_universal.dmg"
```

```powershell
# Windows
Get-AuthenticodeSignature '.\MD Reader_x.y.z_x64-setup.exe' | Format-List
signtool verify /pa /v '.\MD Reader_x.y.z_x64-setup.exe'
```
