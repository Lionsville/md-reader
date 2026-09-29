<#
.SYNOPSIS
  Build the MD Reader Windows installer (NSIS, per-user) and optionally sign it.

.DESCRIPTION
  Without signing options the installer is unsigned (SmartScreen will warn).
  Signing (see docs/SIGNING.md) - pick ONE:
    -CertificateThumbprint <sha1>   certificate in the Windows cert store, incl. an EV/OV
                                    certificate on a USB token (SafeNet etc.): signtool.exe
                                    from the Windows SDK must be on PATH.
    -SignCommand "<cmd ... %1>"     any cloud/HSM signer, e.g. Azure Trusted Signing:
                                    'trusted-signing-cli -e https://weu.codesigning.azure.net -a ACCOUNT -c PROFILE -d "MD Reader" %1'
                                    or SSL.com eSigner / DigiCert KeyLocker (smctl) command lines.
  Env var fallbacks: MDR_CERT_THUMBPRINT, MDR_SIGN_COMMAND.

.EXAMPLE
  .\scripts\build-windows.ps1
  .\scripts\build-windows.ps1 -Arch arm64
  .\scripts\build-windows.ps1 -CertificateThumbprint 0123456789ABCDEF0123456789ABCDEF01234567
#>
param(
  [ValidateSet('x64', 'arm64')] [string] $Arch = 'x64',
  [string] $CertificateThumbprint = $env:MDR_CERT_THUMBPRINT,
  [string] $SignCommand = $env:MDR_SIGN_COMMAND
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$target = if ($Arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
if (Get-Command rustup -ErrorAction SilentlyContinue) { rustup target add $target | Out-Null }
if (-not (Test-Path node_modules)) { npm ci; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
npm run vendor; if ($LASTEXITCODE) { exit $LASTEXITCODE }

$tauriArgs = @('tauri', 'build', '--target', $target)
$signingConfig = $null
if ($CertificateThumbprint -and $SignCommand) { throw 'Use either -CertificateThumbprint or -SignCommand, not both.' }
if ($CertificateThumbprint) {
  $signingConfig = @{ bundle = @{ windows = @{ certificateThumbprint = $CertificateThumbprint } } }
  Write-Host "==> Signing with certificate $CertificateThumbprint (signtool)"
} elseif ($SignCommand) {
  if ($SignCommand -notmatch '%1') { throw '-SignCommand must contain %1 (the file to sign).' }
  $signingConfig = @{ bundle = @{ windows = @{ signCommand = $SignCommand } } }
  Write-Host "==> Signing with custom command"
} else {
  Write-Host "==> No signing configured: building an UNSIGNED installer."
}
if ($signingConfig) {
  $cfgPath = Join-Path $root 'src-tauri/tauri.signing.conf.json'
  # UTF-8 without BOM (Windows PowerShell 5's -Encoding utf8 adds one, which breaks JSON parsing).
  [IO.File]::WriteAllText($cfgPath, ($signingConfig | ConvertTo-Json -Depth 5))
  $tauriArgs += @('--config', $cfgPath)
}

try {
  npx @tauriArgs
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
  if ($signingConfig) { Remove-Item -ErrorAction SilentlyContinue (Join-Path $root 'src-tauri/tauri.signing.conf.json') }
}

$out = Join-Path $root "src-tauri/target/$target/release/bundle/nsis"
Get-ChildItem $out -Filter *.exe | ForEach-Object {
  "{0}  {1:N1} MB" -f $_.FullName, ($_.Length / 1MB)
  $sig = Get-AuthenticodeSignature $_.FullName
  "    signature: $($sig.Status) $($sig.SignerCertificate.Subject)"
}
