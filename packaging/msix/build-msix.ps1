<#
.SYNOPSIS
  Packs the release build of Infinite IPTV into an .msix for the Microsoft Store.

.DESCRIPTION
  Run `npm run tauri -- build --no-bundle` first. The script copies the app binary and the
  tile assets into a layout folder, fills in AppxManifest.xml, indexes resources with makepri
  and packs with makeappx (both from the Windows SDK).

  The package is unsigned on purpose: the Store signs it after certification. To try it
  locally without a certificate, pass -Register (needs Developer Mode) to install the layout
  folder directly.

.EXAMPLE
  ./packaging/msix/build-msix.ps1 -IdentityName 12345Argyris.InfiniteIPTV `
    -Publisher "CN=00000000-0000-0000-0000-000000000000" -PublisherDisplayName "Argyris"
#>
param(
  # Partner Center > Product identity > Package/Identity/Name
  [string] $IdentityName = $(if ($env:MSIX_IDENTITY_NAME) { $env:MSIX_IDENTITY_NAME } else { 'InfiniteIPTV.Dev' }),
  # Partner Center > Product identity > Package/Identity/Publisher
  [string] $Publisher = $(if ($env:MSIX_PUBLISHER) { $env:MSIX_PUBLISHER } else { 'CN=InfiniteIPTV.Dev' }),
  # Partner Center > Product identity > Package/Properties/PublisherDisplayName
  [string] $PublisherDisplayName = $(if ($env:MSIX_PUBLISHER_DISPLAY_NAME) { $env:MSIX_PUBLISHER_DISPLAY_NAME } else { 'Infinite IPTV (dev)' }),
  # Install the unpacked layout for local testing instead of only producing the .msix
  [switch] $Register
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$tauri = Join-Path $root 'src-tauri'
$out = Join-Path $tauri 'target\release\msix'
$layout = Join-Path $out 'layout'

# The Store requires four-part versions with the last part 0: 0.1.0 -> 0.1.0.0
$semver = (Get-Content (Join-Path $tauri 'tauri.conf.json') -Raw | ConvertFrom-Json).version
$core = ($semver -split '[-+]')[0]
$version = "$core.0"

$exe = Join-Path $tauri 'target\release\infinite-iptv.exe'
if (-not (Test-Path $exe)) { throw "Missing $exe. Run 'npm run tauri -- build --no-bundle' first." }

# Newest Windows SDK tools
$sdkBin = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*" -Directory |
  Sort-Object { [version]$_.Name } -Descending |
  Where-Object { Test-Path (Join-Path $_.FullName 'x64\makeappx.exe') } |
  Select-Object -First 1
if (-not $sdkBin) { throw 'makeappx.exe not found. Install the Windows 10/11 SDK.' }
$makeappx = Join-Path $sdkBin.FullName 'x64\makeappx.exe'
$makepri = Join-Path $sdkBin.FullName 'x64\makepri.exe'

Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $layout 'Assets') | Out-Null

Copy-Item $exe $layout
foreach ($asset in 'Square44x44Logo.png', 'Square150x150Logo.png', 'StoreLogo.png') {
  Copy-Item (Join-Path $tauri "icons\$asset") (Join-Path $layout 'Assets')
}

$manifest = Get-Content (Join-Path $PSScriptRoot 'AppxManifest.xml') -Raw
$values = @{
  '{{IDENTITY_NAME}}'          = [Security.SecurityElement]::Escape($IdentityName)
  '{{PUBLISHER}}'              = [Security.SecurityElement]::Escape($Publisher)
  '{{PUBLISHER_DISPLAY_NAME}}' = [Security.SecurityElement]::Escape($PublisherDisplayName)
  '{{VERSION}}'                = $version
}
foreach ($key in $values.Keys) { $manifest = $manifest.Replace($key, $values[$key]) }
Set-Content (Join-Path $layout 'AppxManifest.xml') $manifest -Encoding utf8

$priConfig = Join-Path $out 'priconfig.xml'
& $makepri createconfig /cf $priConfig /dq en-US /o | Out-Host
if ($LASTEXITCODE) { throw "makepri createconfig failed ($LASTEXITCODE)" }
& $makepri new /pr $layout /cf $priConfig /mn (Join-Path $layout 'AppxManifest.xml') /of (Join-Path $layout 'resources.pri') /o | Out-Host
if ($LASTEXITCODE) { throw "makepri new failed ($LASTEXITCODE)" }

$msix = Join-Path $out "InfiniteIPTV_${version}_x64.msix"
& $makeappx pack /d $layout /p $msix /o | Out-Host
if ($LASTEXITCODE) { throw "makeappx pack failed ($LASTEXITCODE)" }
Write-Host "Packed $msix"

if ($Register) {
  Add-AppxPackage -Register (Join-Path $layout 'AppxManifest.xml')
  Write-Host 'Registered. Start "Infinite IPTV" from the Start menu.'
}
