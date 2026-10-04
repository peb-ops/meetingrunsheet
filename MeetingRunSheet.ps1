<#
.SYNOPSIS
    Meeting Run Sheet - an offline facilitation checklist with a library of past meetings.

.DESCRIPTION
    Starts a small web server on your own machine (localhost only) and opens the run sheet
    in your browser. Each meeting is saved as a JSON file in the data folder, so you can
    search, reopen, and follow up on past meetings. No installs or admin rights needed.
    Works in Windows PowerShell 5.1.

    Stop the server with Ctrl+C in the PowerShell window.

    Layout:
      MeetingRunSheet.ps1       this file: settings and startup
      lib\MeetingStore.psm1     class MeetingStore   - meeting JSON files on disk
      lib\WebRoot.psm1          class WebRoot        - serves the page files in web\
      lib\RunSheetServer.psm1   class RunSheetServer - HTTP listener, routing, API
      web\                      the page (index.html, styles.css, content.js, app.js).
                                Edit these and refresh the browser; no restart needed.

.PARAMETER Port
    Port to listen on. Default 8080.

.PARAMETER DataDir
    Folder where meetings are stored. Default: a "meetings" folder next to this script.

.PARAMETER NoBrowser
    Don't open the browser automatically.

.EXAMPLE
    .\MeetingRunSheet.ps1

.EXAMPLE
    .\MeetingRunSheet.ps1 -Port 8090 -DataDir "D:\Notes\Meetings" -NoBrowser
#>
using module .\lib\MeetingStore.psm1
using module .\lib\WebRoot.psm1
using module .\lib\RunSheetServer.psm1

[CmdletBinding()]
param(
    [int]$Port = 8080,
    [string]$DataDir = '',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# Resolve paths here, not in param(): Windows PowerShell 5.1 can leave
# $PSScriptRoot empty while parameter defaults are evaluated.
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $DataDir)   { $DataDir = Join-Path $scriptDir 'meetings' }
# Relative -DataDir is relative to the current folder, as users expect from the command line.
$DataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)

$store  = [MeetingStore]::new($DataDir)
$web    = [WebRoot]::new((Join-Path $scriptDir 'web'))
$server = [RunSheetServer]::new($Port, $store, $web)

try {
    $server.Start()
} catch {
    Write-Host "Couldn't start on $($server.Prefix). The port may be in use; try -Port 8090." -ForegroundColor Red
    Write-Host $_.Exception.Message
    return
}

Write-Host ''
Write-Host "  Meeting Run Sheet is running at $($server.Prefix)" -ForegroundColor Cyan
Write-Host "  Meetings are saved in: $($store.Root)"
Write-Host '  Press Ctrl+C to stop.'
Write-Host ''

if (-not $NoBrowser) {
    try { Start-Process $server.Prefix } catch { Write-Host "Open $($server.Prefix) in your browser." }
}

try {
    $server.Run()
} finally {
    Write-Host 'Server stopped.'
}
