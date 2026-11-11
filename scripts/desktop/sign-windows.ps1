# Signs one Windows file for the Tauri bundler (bundle.windows.signCommand,
# set by scripts/lib/desktop-tauri.mjs only for a signed `win` build). The
# bundler calls it for the app, the uninstaller and the installer in turn.
#
# Exactly one of the two signing sets resolveSigning allows is in the
# environment (scripts/lib/desktop-release.mjs refuses two, and refuses a
# partial one, before anything is built):
#
#   Azure Trusted Signing: AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
#     (read by the module's EnvironmentCredential) and the account, profile and
#     endpoint. Invoked exactly as electron-builder 26 invoked it, so the
#     certificate subject - which electron-updater compares with the
#     publisherName an Electron install carries - is the one v0.3.0 was signed
#     with. The workflow installs the TrustedSigning module first.
#   A certificate file: WIN_CSC_LINK (base64 .pfx) and WIN_CSC_KEY_PASSWORD.
#
# Fails closed: afterwards the file must carry a valid, timestamped signature,
# or the build stops before an unsigned file is packed under a signed name.
param([Parameter(Mandatory)][string]$FilePath)
$ErrorActionPreference = 'Stop'
$file = (Resolve-Path -LiteralPath $FilePath).Path

if ($env:AZURE_TRUSTED_SIGNING_ENDPOINT) {
    Import-Module TrustedSigning
    $params = @{
        Endpoint               = $env:AZURE_TRUSTED_SIGNING_ENDPOINT
        CodeSigningAccountName = $env:AZURE_TRUSTED_SIGNING_ACCOUNT
        CertificateProfileName = $env:AZURE_TRUSTED_SIGNING_PROFILE
        Files                  = $file
        FileDigest             = 'SHA256'
        TimestampRfc3161       = 'http://timestamp.acs.microsoft.com'
        TimestampDigest        = 'SHA256'
    }
    Invoke-TrustedSigning @params
} elseif ($env:WIN_CSC_LINK) {
    $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
        Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName | Select-Object -Last 1
    if (-not $signtool) { throw 'signtool.exe not found (Windows SDK)' }
    $pfx = Join-Path ([System.IO.Path]::GetTempPath()) ("tyt-sign-" + [guid]::NewGuid() + ".pfx")
    try {
        [System.IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WIN_CSC_LINK))
        & $signtool.FullName sign /f $pfx /p $env:WIN_CSC_KEY_PASSWORD /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 $file
        if ($LASTEXITCODE -ne 0) { throw "signtool sign failed for $file" }
    } finally {
        Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
    }
} else {
    throw 'No Windows signing credentials in the environment; this script is only configured for a signed build.'
}

$signature = Get-AuthenticodeSignature -LiteralPath $file
if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) {
    throw "Invalid or untimestamped signature on $file ($($signature.Status))"
}
Write-Host "Signed $file ($($signature.SignerCertificate.Subject))"
