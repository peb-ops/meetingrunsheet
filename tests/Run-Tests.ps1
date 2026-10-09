<#
.SYNOPSIS
    Tests for Meeting Run Sheet. No installs needed.

.DESCRIPTION
    Starts the app on a spare port with a throwaway data folder (your real meetings are
    never touched), runs HTTP checks against the API and page files, then stops it.
    If Microsoft Edge is installed, also loads the page headless and checks it renders.
    Runs the server with the same PowerShell you run this script with (Windows PowerShell 5.1).

    Exit code: 0 if everything passed, 1 otherwise.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1 -Port 8299 -SkipBrowser
#>
[CmdletBinding()]
param(
    [int]$Port = 8199,
    [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'
$testsDir = $PSScriptRoot
if (-not $testsDir) { $testsDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$appDir = Split-Path -Parent $testsDir
$base   = "http://localhost:$Port"
$work   = Join-Path ([System.IO.Path]::GetTempPath()) ('runsheet-tests-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$data   = Join-Path $work 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null

$script:passed = 0
$script:failed = 0

function Check([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:passed++
        Write-Host "  PASS  $Name" -ForegroundColor Green
    } else {
        $script:failed++
        Write-Host "  FAIL  $Name $Detail" -ForegroundColor Red
    }
}

# Sends a request and returns {Status, Type, Body, Json}. Never throws on 4xx/5xx.
# Non-GET requests get the X-Run-Sheet header unless $Headers overrides it.
function Invoke-Api([string]$Method, [string]$Path, [string]$Body = '', [hashtable]$Headers = @{}) {
    $req = [System.Net.HttpWebRequest]::Create("$base$Path")
    $req.Method = $Method
    $req.Timeout = 15000
    if ($Method -ne 'GET') { $req.Headers['X-Run-Sheet'] = '1' }
    foreach ($k in $Headers.Keys) {
        if ($k -eq 'Host') { $req.Host = $Headers[$k] } else { $req.Headers[$k] = $Headers[$k] }
    }
    if ($Body) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
        $req.ContentType = 'application/json'
        $req.ContentLength = $bytes.Length
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
    } elseif ($Method -eq 'POST' -or $Method -eq 'PUT') {
        $req.ContentLength = 0   # as a browser does; Windows answers 411 to a POST with no length
    }
    try {
        $res = $req.GetResponse()
    } catch [System.Net.WebException] {
        $res = $_.Exception.Response
        if (-not $res) { throw }
    }
    $reader = New-Object System.IO.StreamReader($res.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
    $reader.Close()
    $json = $null
    try { if ($text) { $json = $text | ConvertFrom-Json } } catch { }
    $out = [pscustomobject]@{ Status = [int]$res.StatusCode; Type = [string]$res.ContentType; Body = $text; Json = $json; Headers = $res.Headers }
    $res.Close()
    return $out
}

# Like Invoke-Api for binary bodies and downloads: returns {Status, Type, Disposition, Bytes, Json}.
# -Chunked sends the body without a Content-Length.
function Invoke-Raw([string]$Method, [string]$Path, [byte[]]$Body = $null, [hashtable]$Headers = @{}, [switch]$Chunked) {
    $req = [System.Net.HttpWebRequest]::Create("$base$Path")
    $req.Method = $Method
    $req.Timeout = 15000
    if ($Method -ne 'GET') { $req.Headers['X-Run-Sheet'] = '1' }
    foreach ($k in $Headers.Keys) { $req.Headers[$k] = $Headers[$k] }
    if ($null -ne $Body) {
        $req.ContentType = 'application/zip'
        if ($Chunked) { $req.SendChunked = $true } else { $req.ContentLength = $Body.Length }
        $stream = $req.GetRequestStream()
        $stream.Write($Body, 0, $Body.Length)
        $stream.Close()
    }
    try {
        $res = $req.GetResponse()
    } catch [System.Net.WebException] {
        $res = $_.Exception.Response
        if (-not $res) { throw }
    }
    $buffer = New-Object System.IO.MemoryStream
    $res.GetResponseStream().CopyTo($buffer)
    $bytes = $buffer.ToArray()
    $json = $null
    try { $json = [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { }
    $out = [pscustomobject]@{ Status = [int]$res.StatusCode; Type = [string]$res.ContentType
                              Disposition = [string]$res.Headers['Content-Disposition']; Bytes = $bytes; Json = $json }
    $res.Close()
    return $out
}

Add-Type -AssemblyName System.IO.Compression

# A zip in memory from @{ entry name = text }.
function New-Zip([hashtable]$Entries) {
    $buffer = New-Object System.IO.MemoryStream
    $zip = New-Object System.IO.Compression.ZipArchive($buffer, 'Create', $true)
    foreach ($name in $Entries.Keys) {
        $writer = New-Object System.IO.StreamWriter($zip.CreateEntry($name).Open(), (New-Object System.Text.UTF8Encoding($false)))
        $writer.Write($Entries[$name])
        $writer.Dispose()
    }
    $zip.Dispose()
    return , $buffer.ToArray()
}

function Get-ZipNames([byte[]]$Bytes) {
    $zip = New-Object System.IO.Compression.ZipArchive((New-Object System.IO.MemoryStream(, $Bytes)), 'Read')
    try { return @($zip.Entries | ForEach-Object { $_.FullName }) } finally { $zip.Dispose() }
}

function Get-Summary([string]$Id) {
    @((Invoke-Api GET '/api/meetings').Json) | Where-Object { $_.id -eq $Id }
}

# ---------------------------------------------------------------------------
# Start the app
# ---------------------------------------------------------------------------

$hostExe = (Get-Process -Id $PID).Path
$serverArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$appDir\MeetingRunSheet.ps1`" -Port $Port -DataDir `"$data`" -NoBrowser"
$server2 = $null   # a second server for the page interaction checks, started further down
$server = Start-Process -FilePath $hostExe -ArgumentList $serverArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $work 'server.out') -RedirectStandardError (Join-Path $work 'server.err')

try {
    $up = $false
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
        Start-Sleep -Milliseconds 250
        try { $up = (Invoke-Api GET '/').Status -eq 200 } catch { }
        if ($server.HasExited) { break }
    }
    Write-Host ''
    Write-Host "Meeting Run Sheet tests ($($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion), port $Port)" -ForegroundColor Cyan
    Check 'server starts' $up
    if (-not $up) { throw "Server didn't start. See $work\server.err" }

    Write-Host 'Page files'
    $r = Invoke-Api GET '/'
    Check 'GET / serves index.html' ($r.Status -eq 200 -and $r.Type -like 'text/html*' -and $r.Body -match 'styles\.css')
    foreach ($f in 'styles.css', 'theme.js', 'content.js', 'app.js', 'timer.js') {
        $r = Invoke-Api GET "/$f"
        Check "GET /$f" ($r.Status -eq 200 -and $r.Body.Length -gt 0)
    }
    Check 'missing file -> 404'          ((Invoke-Api GET '/nope.js').Status -eq 404)
    Check 'unknown file type -> 404'     ((Invoke-Api GET '/index.ps1').Status -eq 404)
    Check 'path traversal is refused'    ((Invoke-Api GET '/%2e%2e/MeetingRunSheet.ps1').Status -ne 200)
    Check 'foreign Host header refused'  ((Invoke-Api GET '/' '' @{ Host = 'evil.example' }).Status -ne 200)

    Write-Host 'API basics'
    $r = Invoke-Api GET '/api/meetings'
    Check 'empty list is []' ($r.Status -eq 200 -and $r.Body -eq '[]')

    $today = (Get-Date).ToString('yyyy-MM-dd')
    $past  = (Get-Date).AddDays(-3).ToString('yyyy-MM-dd')
    $a = Invoke-Api POST '/api/meetings' (@{
        fields  = @{ title = 'Crash triage'; type = 'triage'; date = '2026-09-20' }
        checks  = @{ 'before:needs-meeting' = $true }
        agenda  = @(@{ id = 'item1'; t = 'Decide ship / cut'; m = 15; d = 'Cut cloud saves'; n = "Risk too high`nRevisit in M4" })
        attendees = @('QA lead')
        actions = @(
            @{ id = 'act1'; a = 'Fix save crash'; o = 'Ana'; d = $past; t = 'GAME-1'; done = $false; g = 'item1' },
            @{ id = 'act2'; a = 'Already done';  o = 'Bo';  d = $past; t = '';       done = $true },
            @{ id = 'act3'; a = 'Profile load';  o = 'Cy';  d = '';    t = '';       done = $false }
        )
    } | ConvertTo-Json -Depth 5)
    Check 'POST creates (201) with server id' ($a.Status -eq 201 -and $a.Json.id -match '^\d{8}-\d{6}-[0-9a-f]{6}$' -and $a.Json.savedAt)
    $idA = $a.Json.id

    $r = Invoke-Api GET '/api/meetings'
    Check 'one-item list is still an array' ($r.Body.StartsWith('[') -and @($r.Json).Count -eq 1)
    $s = Get-Summary $idA
    Check 'summary has no action counts' ($s.title -eq 'Crash triage' -and $r.Body -notmatch 'openActions|overdueActions')

    $r = Invoke-Api GET "/api/meetings/$idA"
    Check 'GET one returns the saved meeting' ($r.Status -eq 200 -and $r.Json.fields.title -eq 'Crash triage' -and $r.Json.checks.'before:needs-meeting' -eq $true)
    # Windows PowerShell's JSON cmdlets can collapse one-item lists; the page needs a list back.
    Check 'one-row agenda is saved as a list' ($r.Body -match '"agenda":\s*\[' -and @($r.Json.agenda)[0].m -eq 15) ($r.Body -replace '\s+', ' ')
    Check 'agenda item keeps its decision and notes' (@($r.Json.agenda)[0].d -eq 'Cut cloud saves' -and @($r.Json.agenda)[0].n -eq "Risk too high`nRevisit in M4")
    Check 'action keeps its agenda item' (@($r.Json.agenda)[0].id -eq 'item1' -and (@($r.Json.actions) | Where-Object { $_.id -eq 'act1' }).g -eq 'item1')
    # The page no longer edits these, but a save must not drop them from older files.
    $byId = @{}; foreach ($x in $r.Json.actions) { $byId[$x.id] = $x }
    Check 'older action fields (due, ticket, done) are kept' ($byId['act1'].d -eq $past -and $byId['act1'].t -eq 'GAME-1' -and $byId['act2'].done -eq $true)
    Check 'one-name attendees is saved as a list' ($r.Body -match '"attendees":\s*\[\s*"QA lead"') ($r.Body -replace '\s+', ' ')

    $r = Invoke-Api PUT "/api/meetings/$idA" (($r.Json | Select-Object fields, checks, actions | ConvertTo-Json -Depth 5) -replace 'Crash triage', 'Crash triage v2')
    Check 'PUT updates and keeps the id' ($r.Status -eq 200 -and $r.Json.id -eq $idA -and $r.Json.fields.title -eq 'Crash triage v2')

    # The page sends the savedAt it opened the meeting with; a save over a newer version is refused.
    $r = Invoke-Api PUT "/api/meetings/$idA" '{"savedAt":"2020-01-01T00:00:00.000","fields":{"title":"Out of date"},"checks":{},"actions":[]}'
    $cur = (Invoke-Api GET "/api/meetings/$idA").Json
    Check 'PUT with an out-of-date savedAt -> 409, nothing written' ($r.Status -eq 409 -and $r.Json.error -and $cur.fields.title -eq 'Crash triage v2')
    $r = Invoke-Api PUT "/api/meetings/$idA" ($cur | ConvertTo-Json -Depth 5)
    Check 'PUT with the current savedAt saves' ($r.Status -eq 200 -and $r.Json.savedAt -and @((Invoke-Api GET "/api/meetings/$idA").Json.actions).Count -eq 3) "(got $($r.Status))"

    Check 'search is case-insensitive'   (@((Invoke-Api GET '/api/meetings?q=CRASH%20TRIAGE').Json).Count -eq 1)
    Check 'search with no match is []'   ((Invoke-Api GET '/api/meetings?q=zzzz').Body -eq '[]')

    Write-Host 'Guards and errors'
    Check 'POST without X-Run-Sheet -> 403'   ((Invoke-Api POST '/api/meetings' '{}' @{ 'X-Run-Sheet' = '0' }).Status -eq 403)
    Check 'DELETE without X-Run-Sheet -> 403' ((Invoke-Api DELETE "/api/meetings/$idA" '' @{ 'X-Run-Sheet' = '0' }).Status -eq 403)
    Check 'unknown id -> 404'                 ((Invoke-Api GET '/api/meetings/does-not-exist').Status -eq 404)
    Check 'invalid id -> 404'                 ((Invoke-Api GET '/api/meetings/bad_id!').Status -eq 404)
    Check 'unknown API path -> 404 JSON'      ((Invoke-Api GET '/api/other').Json.error -eq 'Not found')
    Check 'removed action routes -> 404'      ((Invoke-Api GET '/api/actions').Status -eq 404 -and (Invoke-Api GET '/api/actions.csv').Status -eq 404 -and
        (Invoke-Api PUT "/api/meetings/$idA/actions/act1" '{"done":true}').Status -eq 404)
    $r = Invoke-Api POST '/api/meetings' 'not json'
    Check 'bad JSON -> 500 with an error'     ($r.Status -eq 500 -and $r.Json.error)
    Check '500 does not echo the exception'   ($r.Json.error -notmatch 'JSON') "(got $($r.Json.error))"
    $page = Invoke-Api GET '/'
    $list = Invoke-Api GET '/api/meetings'
    Check 'responses forbid framing and sniffing' ($page.Headers['X-Frame-Options'] -eq 'DENY' -and $list.Headers['X-Frame-Options'] -eq 'DENY' -and
        $page.Headers['X-Content-Type-Options'] -eq 'nosniff' -and $page.Headers['Content-Security-Policy'] -match "default-src 'self'.*frame-ancestors 'none'")
    # Just over the 5 MB limit, sent chunked so there is no Content-Length to go by.
    $big = [System.Text.Encoding]::UTF8.GetBytes('{"fields":{"title":"' + ('x' * (5MB + 1024)) + '"}}')
    $r = Invoke-Raw POST '/api/meetings' $big -Chunked
    Check 'oversized chunked body -> 413'     ($r.Status -eq 413 -and $r.Json.error -and @((Invoke-Api GET '/api/meetings').Json).Count -eq 1) "(got $($r.Status))"

    Write-Host 'Follow-ups'
    # A follow-up only links back: saving or deleting it never changes the meeting it follows.
    $fileA = [System.IO.File]::ReadAllText((Join-Path $data "$idA.json"))
    $b = Invoke-Api POST '/api/meetings' (@{
        follows = $idA
        fields  = @{ title = 'Crash triage v2'; type = 'triage'; date = $today }
        checks  = @{}
        actions = @(@{ id = 'act1'; a = 'Fix save crash'; o = 'Ana' })
    } | ConvertTo-Json -Depth 5)
    $idB = $b.Json.id
    Check 'follow-up saves with follows' ($b.Status -eq 201 -and $b.Json.follows -eq $idA)
    Check 'saving a follow-up leaves the original untouched' ([System.IO.File]::ReadAllText((Join-Path $data "$idA.json")) -eq $fileA)
    $r = Invoke-Api DELETE "/api/meetings/$idB"
    Check 'deleting a follow-up leaves the original untouched' ($r.Json.deleted -eq $idB -and [System.IO.File]::ReadAllText((Join-Path $data "$idA.json")) -eq $fileA)
    Check 'deleted meeting is gone' ((Invoke-Api GET "/api/meetings/$idB").Status -eq 404)
    Check 'its file is kept in the deleted folder' ((Test-Path (Join-Path $data "deleted\$idB.json")) -and -not (Test-Path (Join-Path $data "$idB.json")))
    $r = Invoke-Api POST '/api/meetings' '{"follows":"no-such-meeting","fields":{"title":"x"},"checks":{},"actions":[]}'
    Check 'follows pointing nowhere is harmless' ($r.Status -eq 201)
    [void](Invoke-Api DELETE "/api/meetings/$($r.Json.id)")

    Write-Host 'Files on disk'
    $legacy = '{"fields":{"title":"Old v1.0 meeting","type":"standup","date":"2026-01-05"},"checks":{"before-0":true},"actions":[{"a":"old","o":"x","d":"","t":"","done":false}],"id":"20260105-090000-abcdef","savedAt":"2026-01-05T09:00:00"}'
    [System.IO.File]::WriteAllText((Join-Path $data '20260105-090000-abcdef.json'), $legacy, (New-Object System.Text.UTF8Encoding($false)))
    Check 'v1.0 file (no action ids) lists and opens' ((Get-Summary '20260105-090000-abcdef').title -eq 'Old v1.0 meeting' -and (Invoke-Api GET '/api/meetings/20260105-090000-abcdef').Status -eq 200)
    $files = @(Get-ChildItem -LiteralPath $data)
    Check 'no .tmp files left behind' (-not ($files | Where-Object { $_.Extension -eq '.tmp' }))
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $data "$idA.json"))
    Check 'saved files have no BOM' (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF))

    Write-Host 'Backup and restore'
    $r = Invoke-Raw GET '/api/backup'
    $names = @(); try { $names = Get-ZipNames $r.Bytes } catch { }
    Check 'backup is a zip download' ($r.Status -eq 200 -and $r.Type -eq 'application/zip' -and $r.Disposition -match 'attachment; filename="meetings-backup-[0-9-]+\.zip"') "($($r.Status) $($r.Type) $($r.Disposition))"
    Check 'backup holds every meeting' ($names.Count -eq 2 -and $names -contains "$idA.json" -and $names -contains '20260105-090000-abcdef.json') "(got $($names -join ', '))"
    $backup = $r.Bytes

    Check 'restore without X-Run-Sheet -> 403' ((Invoke-Raw POST '/api/backup' $backup @{ 'X-Run-Sheet' = '0' }).Status -eq 403)
    $r = Invoke-Raw POST '/api/backup' ([System.Text.Encoding]::UTF8.GetBytes('not a zip'))
    Check 'restore of a non-zip -> 400' ($r.Status -eq 400 -and $r.Json.error)
    $r = Invoke-Raw POST '/api/backup' $backup
    Check 'restore never overwrites (all skipped)' ($r.Status -eq 200 -and $r.Json.added -eq 0 -and $r.Json.skipped -eq 2) "($($r.Status) $($r.Json | ConvertTo-Json -Compress))"

    $fileA = [System.IO.File]::ReadAllText((Join-Path $data "$idA.json"))
    [void](Invoke-Api DELETE "/api/meetings/$idA")
    $r = Invoke-Raw POST '/api/backup' $backup
    Check 'restore brings back a deleted meeting' ($r.Json.added -eq 1 -and $r.Json.skipped -eq 1 -and (Invoke-Api GET "/api/meetings/$idA").Json.fields.title -eq 'Crash triage v2')
    Check 'restored file matches the original' ([System.IO.File]::ReadAllText((Join-Path $data "$idA.json")) -eq $fileA)

    $odd = New-Zip @{
        '../escape.json'                  = '{"fields":{"title":"x"}}'
        'sub/20260101-000000-aaaaaa.json' = '{"fields":{"title":"x"}}'
        'bad id!.json'                    = '{"fields":{"title":"x"}}'
        '20260101-000000-bbbbbb.json'     = 'not json'
        '20260101-000000-cccccc.json'     = '{"fields":{"title":"x"},"id":"some-other-id"}'
        'notes.txt'                       = 'hello'
    }
    $r = Invoke-Raw POST '/api/backup' $odd
    Check 'restore skips paths, bad ids and bad files' ($r.Json.added -eq 0 -and $r.Json.invalid -eq 6 -and @(Get-ChildItem -LiteralPath $data -File).Count -eq 2 -and -not (Test-Path (Join-Path $work 'escape.json'))) "($($r.Json | ConvertTo-Json -Compress))"

    # A meeting file with no "id" inside: later writes must still go to the file it came from.
    $noId = '20260102-000000-dddddd'
    $r = Invoke-Raw POST '/api/backup' (New-Zip @{ "$noId.json" = '{"fields":{"title":"No id inside"},"actions":[{"id":"n1","a":"Tick me","o":"","d":"","t":"","done":false}]}' })
    $t = Invoke-Api PUT "/api/meetings/$noId" '{"fields":{"title":"No id inside, saved"},"checks":{},"actions":[]}'
    $m = (Invoke-Api GET "/api/meetings/$noId").Json
    Check 'saving a restored file without an id stays in that file' ($r.Json.added -eq 1 -and $t.Status -eq 200 -and $m.fields.title -eq 'No id inside, saved' -and $m.id -eq $noId -and
        -not (Test-Path (Join-Path $data '.json')) -and @(Get-ChildItem -LiteralPath $data -File).Count -eq 3) "(files: $((Get-ChildItem -LiteralPath $data -File).Name -join ', '))"
    [void](Invoke-Api DELETE "/api/meetings/$noId")

    Write-Host 'Deleted meetings and startup backups'
    # In the deleted folder now: the follow-up ($idB), two throwaway meetings, and a copy of $idA
    # from before it was restored from the backup.
    $r = Invoke-Api GET '/api/deleted'
    $gone = @($r.Json | ForEach-Object { $_.id })
    Check 'deleted meetings are listed' ($r.Status -eq 200 -and $r.Body.StartsWith('[') -and $gone -contains $idB -and
        ($r.Json | Where-Object { $_.id -eq $idB }).title -eq 'Crash triage v2') "(got $($r.Body))"
    Check 'a deleted copy of a meeting that is back is not listed' ($gone -notcontains $idA)
    Check 'put back without X-Run-Sheet -> 403' ((Invoke-Api POST "/api/deleted/$idB" '' @{ 'X-Run-Sheet' = '0' }).Status -eq 403)
    $r = Invoke-Api POST "/api/deleted/$idB"
    Check 'put back returns a deleted meeting' ($r.Status -eq 200 -and $r.Json.restored -eq $idB -and (Invoke-Api GET "/api/meetings/$idB").Json.follows -eq $idA -and
        -not (Test-Path (Join-Path $data "deleted\$idB.json"))) "(got $($r.Status))"
    $fileA = [System.IO.File]::ReadAllText((Join-Path $data "$idA.json"))
    $r = Invoke-Api POST "/api/deleted/$idA"
    Check 'put back never overwrites a meeting (409)' ($r.Status -eq 409 -and [System.IO.File]::ReadAllText((Join-Path $data "$idA.json")) -eq $fileA -and
        (Test-Path (Join-Path $data "deleted\$idA.json")))
    Check 'put back of an unknown or invalid id -> 404' ((Invoke-Api POST '/api/deleted/does-not-exist').Status -eq 404 -and (Invoke-Api POST '/api/deleted/bad_id!').Status -eq 404)
    [void](Invoke-Api DELETE "/api/meetings/$idB")

    Check 'no startup backups is []' ((Invoke-Api GET '/api/backups').Body -eq '[]')
    # A startup backup, put there by hand (this server started with no meetings, so it made none).
    $backupDir = Join-Path $data 'backups'
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $backupDir 'meetings-20260101-080500.zip'), $backup)
    [System.IO.File]::WriteAllText((Join-Path $backupDir 'meetings-20260102-080500.zip'), 'not a zip')
    $r = Invoke-Api GET '/api/backups'
    Check 'startup backups are listed with their time and size' ($r.Body.StartsWith('[') -and @($r.Json).Count -eq 1 -and @($r.Json)[0].name -eq 'meetings-20260101-080500.zip' -and
        @($r.Json)[0].at -eq '2026-01-01 08:05' -and @($r.Json)[0].count -eq 2) "(got $($r.Body))"
    [void](Invoke-Api DELETE '/api/meetings/20260105-090000-abcdef')
    $r = Invoke-Api POST '/api/backups/meetings-20260101-080500.zip'
    Check 'restore from a startup backup adds what is missing' ($r.Status -eq 200 -and $r.Json.added -eq 1 -and $r.Json.skipped -eq 1 -and
        (Invoke-Api GET '/api/meetings/20260105-090000-abcdef').Status -eq 200) "($($r.Status) $($r.Body))"
    Check 'restore from an unknown or odd backup name -> 404' ((Invoke-Api POST '/api/backups/meetings-20990101-000000.zip').Status -eq 404 -and
        (Invoke-Api POST '/api/backups/evil.zip').Status -eq 404 -and (Invoke-Api POST '/api/backups/..%5Cx.zip').Status -eq 404)
    Check 'restore from a broken startup backup -> 400' ((Invoke-Api POST '/api/backups/meetings-20260102-080500.zip').Status -eq 400)
    Remove-Item -LiteralPath $backupDir -Recurse -Force

    Write-Host 'Page settings'
    Check 'no settings stored is {}' ((Invoke-Api GET '/api/settings').Body -eq '{}')
    Check 'settings without X-Run-Sheet -> 403' ((Invoke-Api PUT '/api/settings' '{"theme":"dark"}' @{ 'X-Run-Sheet' = '0' }).Status -eq 403)
    $r = Invoke-Api PUT '/api/settings' '{"theme":"dark","sideOff":true,"other":"x"}'
    $s = Invoke-Api GET '/api/settings'
    Check 'settings are stored, known keys only' ($r.Status -eq 200 -and $s.Json.theme -eq 'dark' -and $s.Json.sideOff -eq $true -and $s.Body -notmatch 'other') "(got $($s.Body))"
    $r = Invoke-Api PUT '/api/settings' '{"theme":"../x","sideOff":"yes"}'
    Check 'a bad theme or sidebar value is stored as the default' ($r.Json.theme -eq '' -and $r.Json.sideOff -eq $false) "(got $($r.Body))"
    Check 'the settings file is not taken for a meeting' (@((Invoke-Api GET '/api/meetings').Json).Count -eq 2 -and (Test-Path (Join-Path $data 'settings\page.json')))

    Write-Host 'Calendar and readiness'
    # Two meetings on the same day next week: one prepared, one not. They stay for the page checks.
    $next = (Get-Date).AddDays(7).ToString('yyyy-MM-dd')
    $u1 = (Invoke-Api POST '/api/meetings' (@{
        fields  = @{ title = 'Prepared review'; type = 'design'; date = $next; time = '14:00'; goal = 'approve or rework' }
        checks  = @{ 'before:send-agenda' = $true; 'before:prep-room' = $true; 'during:start-on-time' = $true }
        agenda  = @(@{ t = 'Risks'; m = 20 })
        actions = @(@{ id = 'tk1'; a = 'Write up risks'; o = 'Dee'; d = $next; t = 'https://tracker.example/GAME-9'; done = $false })
        series  = 'weekly-1'
    } | ConvertTo-Json -Depth 5)).Json.id
    $u2 = (Invoke-Api POST '/api/meetings' (@{
        fields  = @{ title = 'Unprepared sync'; type = 'general'; date = $next; time = '09:00' }
        checks  = @{ 'before:send-agenda' = $true; 'before:prep-room' = $false }
        actions = @()
    } | ConvertTo-Json -Depth 5)).Json.id
    $r = Invoke-Api GET '/api/meetings'
    $s1 = @($r.Json) | Where-Object { $_.id -eq $u1 }
    $s2 = @($r.Json) | Where-Object { $_.id -eq $u2 }
    Check 'summary has start time and prep info' ($s1.time -eq '14:00' -and $s1.hasGoal -eq $true -and $s1.agendaCount -eq 1 -and @($s1.beforeChecks).Count -eq 2 -and $s1.date -eq $next)
    Check 'summary prep info for an unprepared meeting' ($s2.hasGoal -eq $false -and $s2.agendaCount -eq 0)
    Check 'summary and file carry the series of a repeated meeting' ($s1.series -eq 'weekly-1' -and $s2.series -eq '' -and (Invoke-Api GET "/api/meetings/$u1").Json.series -eq 'weekly-1')
    Check 'one ticked item stays a list' ($r.Body -match ('"id":"' + $u2 + '"[^}]*"beforeChecks":\["send-agenda"\]') -or $r.Body -match ('"beforeChecks":\["send-agenda"\][^}]*"id":"' + $u2 + '"')) ($r.Body -replace '\s+', ' ')
    Check 'no ticks is an empty list' (@(@($r.Json) | Where-Object { $_.id -eq '20260105-090000-abcdef' })[0].beforeChecks.Count -eq 0 -and $r.Body -match '"beforeChecks":\[\]')
    $ids = @($r.Json | ForEach-Object { $_.id })
    Check 'same day sorts by start time (latest first)' ([array]::IndexOf($ids, $u1) -lt [array]::IndexOf($ids, $u2) -and [array]::IndexOf($ids, $u1) -ge 0)

    # -----------------------------------------------------------------------
    # Page renders in a real browser (optional)
    # -----------------------------------------------------------------------
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
              "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($SkipBrowser -or -not $edge) {
        Write-Host 'Page render: skipped (no Edge, or -SkipBrowser)' -ForegroundColor Yellow
    } else {
        Write-Host 'Page render (headless Edge)'
        # The page's HTML after its scripts have run.
        function Get-Dom([string]$Url, [string]$Name, [int]$Budget = 4000) {
            $domFile = Join-Path $work "$Name.html"
            $edgeArgs = "--headless --disable-gpu --no-first-run --user-data-dir=`"$work\edge-$Name`" --virtual-time-budget=$Budget --dump-dom $Url"
            $p = Start-Process -FilePath $edge -ArgumentList $edgeArgs -RedirectStandardOutput $domFile -PassThru -WindowStyle Hidden
            if (-not $p.WaitForExit(45000)) { try { $p.Kill() } catch { } }
            # Edge's helper processes can keep the output file open, so read it shared, then stop them.
            $text = ''
            if (Test-Path $domFile) {
                $fs = [System.IO.File]::Open($domFile, 'Open', 'Read', 'ReadWrite')
                try { $text = (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
            }
            Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
                Where-Object { $_.CommandLine -like "*$work*" } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            return $text
        }
        $dom = Get-Dom "$base/" 'dom'
        $count = { param($pattern) ([regex]::Matches($dom, $pattern)).Count }
        Check 'checklist renders 12 items'        ((& $count 'id="chk-') -eq 12) "(got $(& $count 'id="chk-'))"
        Check 'type dropdown has 8 types'         ((& $count '<option value="(general|kickoff|planning|triage|playtest|design|milestone|retro)"') -eq 8)
        Check 'help tooltips are built (7)'       ((& $count 'class="label-row') -eq 7)
        Check 'sidebar lists saved meetings'      ($dom -match 'Crash triage v2')
        Check 'list has no action badges'         ($dom -notmatch 'class="pill (open|overdue)"' -and $dom -notmatch '\d+ (open|overdue)<')
        Check 'timer bar is present and hidden'   ($dom -match 'id="timerBar"[^>]*hidden')
        Check 'agenda editor shows one empty row' ((& $count 'id="ag-t-') -eq 1)
        Check 'agenda item is a wrapping box with a time rail' ($dom -match '<td class="at"[^>]*></td><td class="n">1</td>' -and $dom -match '<textarea id="ag-t-0"[^>]*></textarea><span aria-hidden="true"> </span>')
        Check 'agenda item has a closed record with an action list' ($dom -match 'class="rec-toggle"[^>]*aria-expanded="false"' -and $dom -match 'id="ag-rec-0"[^>]*hidden' -and $dom -match '<div class="rec-acts"><button class="ghost sm">\+ Add action</button></div>')
        Check 'the summary is on the page' ($dom -match 'id="summary"><div class="sum-none">Nothing recorded yet\.</div>')
        Check 'other decisions is a list with one empty row' ((& $count 'id="dec-') -eq 1 -and $dom -notmatch 'id="f-decisions"')
        Check 'an agenda item can be marked left open' ($dom -match '<input type="checkbox" id="ag-o-0">')
        Check 'loose actions, Last time and Repeat weekly start hidden' ($dom -match 'id="looseActs"[^>]*hidden' -and $dom -match 'id="lastTime"[^>]*hidden' -and $dom -match 'id="repeatBox"[^>]*hidden' -and $dom -match 'id="repeatBtn"')
        Check 'Wrap up has a print button and a print heading' ($dom -match 'id="printBtn"' -and $dom -match 'id="printHead"><h1>Meeting notes</h1>')
        Check 'the print heading comes before the outcome strip' ($dom.IndexOf('id="printHead"') -gt 0 -and $dom.IndexOf('id="printHead"') -lt $dom.IndexOf('aria-label="Outcome"'))
        Check 'deleted meetings card and series line start hidden' ($dom -match 'id="binBox"[^>]*hidden' -and $dom -match 'id="binBtn"' -and $dom -match 'id="seriesLine"[^>]*hidden')
        Check 'sheet opens on the Plan phase' ($dom -match 'id="sheet" data-phase="plan"' -and $dom -match '<button data-phase="plan" aria-current="true">1 Plan</button>' -and $dom -notmatch '<button data-phase="run" aria-current')
        Check 'readiness strip is filled in' ($dom -match 'id="rGoal"><b>Goal</b> missing<' -and $dom -notmatch 'class="ready-item ok" id="rAgenda"' -and $dom -match 'id="rPrep"><b>Prep</b> 0 of 2 done<' -and $dom -match 'id="timerBtn"')
        Check 'checklist phases are tagged for the phase view' ((& $count 'class="phase" data-id="') -eq 3 -and $dom -match 'id="f-goalmet"')
        Check 'attendee list shows one empty row' ((& $count 'id="att-') -eq 1)
        Check 'parking lot is a list with one empty row' ((& $count 'id="park-') -eq 1 -and $dom -notmatch 'id="f-parking"')
        Check 'summary ends with the parking lot; no action table' ($dom -match '<div class="sum-head">Parking lot</div><div class="sum-none">Nothing parked\.</div></div></div>' -and $dom -notmatch 'id="actionRows"' -and $dom -notmatch 'Carried over / no agenda item')
        Check 'menu has backup and restore'       ($dom -match 'id="backupBtn"' -and $dom -match 'id="restoreBtn"')
        Check 'no action tracking on the page'    ($dom -notmatch 'id="(csvBtn|ticketBtn|ticketBox|actionsBtn|actionsView)"')
        Check 'calendar grid has 42 days'         ((& $count 'class="day') -eq 42) "(got $(& $count 'class="day'))"
        Check 'list has Upcoming and Past groups' ($dom -match '<div class="group">Upcoming</div>' -and $dom -match '<div class="group">Past</div>')
        Check 'readiness badges show'             ($dom -match 'class="pill ready">Ready<' -and $dom -match 'class="pill prep">Needs goal, agenda, prep 1/2<')
        Check 'start time field is present'       ($dom -match 'id="f-time"')
        Check 'section nav lists 6 sections'     ((& $count 'class="jump-link') -eq 6) "(got $(& $count 'class="jump-link'))"
        $appJs = (Invoke-Api GET '/app.js').Body
        Check 'owner boxes use the suggestion list' ($dom -match '<datalist id="ownerList">' -and $appJs -match 'list="ownerList" aria-label="Owner"')
        Check 'an action line has no due date box' ($appJs -notmatch 'aria-label="Due"' -and $appJs -notmatch 'type="date" aria-label')
        Check 'menu has both Copy notes entries'   ($dom -match 'id="copyBtn"' -and $dom -match 'id="copyMdBtn"')
        Check 'theme follows the system until one is picked' ($dom -match 'id="themeBtn"[^>]*>Theme: System<' -and $dom -notmatch '<html[^>]*data-theme')
        Check 'theme list has 7 themes with System ticked' ((& $count 'role="menuitemradio"') -eq 7 -and $dom -match '<button[^>]*aria-checked="true"[^>]*>System</button>' -and (& $count 'aria-checked="true"') -eq 1 -and $dom -match 'id="themeList"[^>]*hidden') "(got $(& $count 'role="menuitemradio"'))"

        # -------------------------------------------------------------------
        # Using the page: typing, Enter, clicks, save and reopen (tests\selftest.js)
        # -------------------------------------------------------------------
        Write-Host 'Page interaction (headless Edge)'
        # A copy of the app with the driver script added to the page, on the next port with its own
        # data folder. That folder starts with one meeting, so this server writes a startup backup.
        $app2  = Join-Path $work 'app'
        $data2 = Join-Path $work 'data2'
        New-Item -ItemType Directory -Path $app2, $data2 -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $appDir 'MeetingRunSheet.ps1') -Destination $app2
        Copy-Item -LiteralPath (Join-Path $appDir 'lib') -Destination $app2 -Recurse
        Copy-Item -LiteralPath (Join-Path $appDir 'web') -Destination $app2 -Recurse
        Copy-Item -LiteralPath (Join-Path $testsDir 'selftest.js') -Destination (Join-Path $app2 'web')
        $index = Join-Path $app2 'web\index.html'
        [System.IO.File]::WriteAllText($index, [System.IO.File]::ReadAllText($index).Replace('</body>', '<script src="selftest.js"></script></body>'), (New-Object System.Text.UTF8Encoding($false)))
        Copy-Item -LiteralPath (Join-Path $data "$idA.json") -Destination $data2
        $base2 = "http://localhost:$($Port + 1)"
        $server2 = Start-Process -FilePath $hostExe -PassThru -WindowStyle Hidden `
            -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$app2\MeetingRunSheet.ps1`" -Port $($Port + 1) -DataDir `"$data2`" -NoBrowser" `
            -RedirectStandardOutput (Join-Path $work 'server2.out') -RedirectStandardError (Join-Path $work 'server2.err')
        $up = $false
        for ($i = 0; $i -lt 60 -and -not $up -and -not $server2.HasExited; $i++) {
            Start-Sleep -Milliseconds 250
            try { $res = [System.Net.HttpWebRequest]::Create("$base2/").GetResponse(); $up = [int]$res.StatusCode -eq 200; $res.Close() } catch { }
        }
        Check 'second server starts from the copy' $up
        Check 'startup writes a backup zip when there are meetings' (@(Get-ChildItem -Path (Join-Path $data2 'backups') -Filter 'meetings-*.zip' -ErrorAction SilentlyContinue).Count -eq 1)
        Check 'no startup backup for an empty data folder' (-not (Test-Path (Join-Path $data 'backups')))

        $dom = Get-Dom "$base2/#selftest" 'selftest' 20000
        $found = [regex]::Match($dom, '<pre id="selftest">([\s\S]*?)</pre>')
        $lines = @()
        if ($found.Success) { $lines = @($found.Groups[1].Value -split "`r?`n" | Where-Object { $_.Trim() }) }
        Check 'interaction script ran' ($lines.Count -gt 0)
        foreach ($line in $lines) { Check ('page: ' + $line.Substring(5)) ($line.StartsWith('PASS ')) }
        Check 'Delete then Put back left nothing in the deleted folder' ((Test-Path (Join-Path $data2 'deleted')) -and @(Get-ChildItem -Path (Join-Path $data2 'deleted') -Filter '*.json').Count -eq 0)
        Check 'page settings are a file in the data folder' (Test-Path (Join-Path $data2 'settings\page.json'))
    }
} finally {
    if ($server2 -and -not $server2.HasExited) { Stop-Process -Id $server2.Id -Force }
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    $err = Join-Path $work 'server.err'
    if ((Test-Path $err) -and (Get-Item $err).Length -gt 0) {
        Write-Host 'Server stderr:' -ForegroundColor Yellow
        Get-Content $err | Write-Host
    }
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
$color = if ($script:failed) { 'Red' } else { 'Green' }
Write-Host "$($script:passed) passed, $($script:failed) failed" -ForegroundColor $color
if ($script:failed) { exit 1 } else { exit 0 }
