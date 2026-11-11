# Packs the unpacked Tauri app into an MSIX for the Microsoft Store
# (`node scripts/build-desktop.mjs --channel win-store --package --bundles appx`).
# The package is NOT signed here: Partner Center signs it on upload, and a
# package signed with a certificate whose subject differs from the reserved
# publisher is refused. The identity is never defaulted (resolveSigning
# requires all three before anything is built).
#
# The app finds out it runs from this package at run time (its package
# identity), and then leaves updates, open at login and activity capture to
# the Store's rules (tyt_model::distribution).
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string]$Arch,
    [Parameter(Mandatory)][string]$Assets
)
$ErrorActionPreference = 'Stop'
foreach ($name in @('WINDOWS_STORE_IDENTITY_NAME', 'WINDOWS_STORE_PUBLISHER', 'WINDOWS_STORE_PUBLISHER_DISPLAY_NAME')) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing $name" }
}
$escape = { param($s) [System.Security.SecurityElement]::Escape($s) }
$name = & $escape $env:WINDOWS_STORE_IDENTITY_NAME
$publisher = & $escape $env:WINDOWS_STORE_PUBLISHER
$display = & $escape $env:WINDOWS_STORE_PUBLISHER_DISPLAY_NAME

New-Item -ItemType Directory -Force (Join-Path $Source 'Assets') | Out-Null
Copy-Item (Join-Path $Assets '*.png') (Join-Path $Source 'Assets')
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="$name" Publisher="$publisher" Version="$Version" ProcessorArchitecture="$Arch"/>
  <Properties>
    <DisplayName>Track Your Time</DisplayName>
    <PublisherDisplayName>$display</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-US"/>
    <Resource Language="de-DE"/>
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0"/>
  </Dependencies>
  <Applications>
    <Application Id="TrackYourTime" Executable="Track Your Time.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Track Your Time" Description="Free, open-source time tracking"
        BackgroundColor="#4F46E5" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png"/>
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
    <Capability Name="internetClient"/>
  </Capabilities>
</Package>
"@
Set-Content -LiteralPath (Join-Path $Source 'AppxManifest.xml') -Value $manifest -Encoding utf8
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'Windows SDK makeappx.exe not found' }
& $makeappx.FullName pack /d $Source /p $Output /o
if ($LASTEXITCODE -ne 0) { throw 'MSIX packaging failed' }
