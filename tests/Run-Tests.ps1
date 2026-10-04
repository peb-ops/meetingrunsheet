<#
.SYNOPSIS
    Tests for Meeting Run Sheet. No installs needed.

.DESCRIPTION
    Starts the app on a spare port with a throwaway data folder (your real meetings are
    never touched), runs HTTP checks against the API and page files, then stops it.
    If Microsoft Edge is installed, also loads the page headless and checks it renders.
    Runs the server with the same PowerShell you run this script with, so run it once
    with powershell.exe (5.1) and once with pwsh (7) to cover both.

    Exit code: 0 if everything passed, 1 otherwise.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1

.EXAMPLE
    pwsh -NoProfile -File .\tests\Run-Tests.ps1 -Port 8299 -SkipBrowser
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
    $out = [pscustomobject]@{ Status = [int]$res.StatusCode; Type = [string]$res.ContentType; Body = $text; Json = $json }
    $res.Close()
    return $out
}

# Like Invoke-Api for binary bodies and downloads: returns {Status, Type, Disposition, Bytes, Json}.
function Invoke-Raw([string]$Method, [string]$Path, [byte[]]$Body = $null, [hashtable]$Headers = @{}) {
    $req = [System.Net.HttpWebRequest]::Create("$base$Path")
    $req.Method = $Method
    $req.Timeout = 15000
    if ($Method -ne 'GET') { $req.Headers['X-Run-Sheet'] = '1' }
    foreach ($k in $Headers.Keys) { $req.Headers[$k] = $Headers[$k] }
    if ($null -ne $Body) {
        $req.ContentType = 'application/zip'
        $req.ContentLength = $Body.Length
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
    foreach ($f in 'styles.css', 'content.js', 'app.js', 'timer.js') {
        $r = Invoke-Api GET "/$f"
        Check "GET /$f" ($r.Status -eq 200 -and $r.Body.Length -gt 0)
    }
    # content.js: every meeting type (a "  key: [" line under TYPES) has a starter agenda under AGENDAS.
    $parts = (Invoke-Api GET '/content.js').Body -split 'const AGENDAS', 2
    $keys = { param($text) @([regex]::Matches($text, '(?m)^  (\w+):\s*\[') | ForEach-Object { $_.Groups[1].Value } | Sort-Object) }
    $typesText = ($parts[0] -split 'const TYPES', 2)[1]
    $typeKeys = & $keys $typesText
    $agendaKeys = & $keys $parts[1]
    Check 'every meeting type has an agenda template' ($typeKeys.Count -eq 8 -and ($typeKeys -join ',') -eq ($agendaKeys -join ',')) "(types: $($typeKeys -join ','); agendas: $($agendaKeys -join ','))"
    Check 'missing file -> 404'          ((Invoke-Api GET '/nope.js').Status -eq 404)
    Check 'unknown file type -> 404'     ((Invoke-Api GET '/index.ps1').Status -eq 404)
    Check 'path traversal is refused'    ((Invoke-Api GET '/%2e%2e/MeetingRunSheet.ps1').Status -ne 200)
    Check 'foreign Host header refused'  ((Invoke-Api GET '/' '' @{ Host = 'evil.example' }).Status -ne 200)

    Write-Host 'API basics'
    $r = Invoke-Api GET '/api/meetings'
    Check 'empty list is []' ($r.Status -eq 200 -and $r.Body -eq '[]')
    Check 'no open actions is []' ((Invoke-Api GET '/api/actions').Body -eq '[]')

    $today = (Get-Date).ToString('yyyy-MM-dd')
    $past  = (Get-Date).AddDays(-3).ToString('yyyy-MM-dd')
    $a = Invoke-Api POST '/api/meetings' (@{
        fields  = @{ title = 'Crash triage'; type = 'triage'; date = '2026-09-20' }
        checks  = @{ 'before:needs-meeting' = $true }
        agenda  = @(@{ t = 'Decide ship / cut'; m = 15 })
        attendees = @('QA lead')
        actions = @(
            @{ id = 'act1'; a = 'Fix save crash'; o = 'Ana'; d = $past; t = 'GAME-1'; done = $false },
            @{ id = 'act2'; a = 'Already done';  o = 'Bo';  d = $past; t = '';       done = $true },
            @{ id = 'act3'; a = 'Profile load';  o = 'Cy';  d = '';    t = '';       done = $false }
        )
    } | ConvertTo-Json -Depth 5)
    Check 'POST creates (201) with server id' ($a.Status -eq 201 -and $a.Json.id -match '^\d{8}-\d{6}-[0-9a-f]{6}$' -and $a.Json.savedAt)
    $idA = $a.Json.id

    $r = Invoke-Api GET '/api/meetings'
    Check 'one-item list is still an array' ($r.Body.StartsWith('[') -and @($r.Json).Count -eq 1)
    $s = Get-Summary $idA
    Check 'openActions counts open actions' ($s.openActions -eq 2) "(got $($s.openActions))"
    Check 'overdueActions counts past-due open actions' ($s.overdueActions -eq 1) "(got $($s.overdueActions))"

    $r = Invoke-Api GET "/api/meetings/$idA"
    Check 'GET one returns the saved meeting' ($r.Status -eq 200 -and $r.Json.fields.title -eq 'Crash triage' -and $r.Json.checks.'before:needs-meeting' -eq $true)
    # Windows PowerShell's JSON cmdlets can collapse one-item lists; the page needs a list back.
    Check 'one-row agenda is saved as a list' ($r.Body -match '"agenda":\s*\[' -and @($r.Json.agenda)[0].m -eq 15) ($r.Body -replace '\s+', ' ')
    Check 'one-name attendees is saved as a list' ($r.Body -match '"attendees":\s*\[\s*"QA lead"') ($r.Body -replace '\s+', ' ')

    $r = Invoke-Api PUT "/api/meetings/$idA" (($r.Json | Select-Object fields, checks, actions | ConvertTo-Json -Depth 5) -replace 'Crash triage', 'Crash triage v2')
    Check 'PUT updates and keeps the id' ($r.Status -eq 200 -and $r.Json.id -eq $idA -and $r.Json.fields.title -eq 'Crash triage v2')

    Check 'search is case-insensitive'   (@((Invoke-Api GET '/api/meetings?q=CRASH%20TRIAGE').Json).Count -eq 1)
    Check 'search with no match is []'   ((Invoke-Api GET '/api/meetings?q=zzzz').Body -eq '[]')

    Write-Host 'Guards and errors'
    Check 'POST without X-Run-Sheet -> 403'   ((Invoke-Api POST '/api/meetings' '{}' @{ 'X-Run-Sheet' = '0' }).Status -eq 403)
    Check 'DELETE without X-Run-Sheet -> 403' ((Invoke-Api DELETE "/api/meetings/$idA" '' @{ 'X-Run-Sheet' = '0' }).Status -eq 403)
    Check 'unknown id -> 404'                 ((Invoke-Api GET '/api/meetings/does-not-exist').Status -eq 404)
    Check 'invalid id -> 404'                 ((Invoke-Api GET '/api/meetings/bad_id!').Status -eq 404)
    Check 'unknown API path -> 404 JSON'      ((Invoke-Api GET '/api/other').Json.error -eq 'Not found')
    $r = Invoke-Api POST '/api/meetings' 'not json'
    Check 'bad JSON -> 500 with an error'     ($r.Status -eq 500 -and $r.Json.error)

    Write-Host 'Follow-ups and carried actions'
    $savedAtA = (Invoke-Api GET "/api/meetings/$idA").Json.savedAt
    $b = Invoke-Api POST '/api/meetings' (@{
        follows = $idA
        fields  = @{ title = 'Crash triage v2'; type = 'triage'; date = $today }
        checks  = @{}
        actions = @(
            @{ id = 'act1'; a = 'Fix save crash'; o = 'Ana'; d = $past; t = 'GAME-1'; done = $false },
            @{ id = 'act3'; a = 'Profile load';  o = 'Cy';  d = '';    t = '';       done = $false }
        )
    } | ConvertTo-Json -Depth 5)
    $idB = $b.Json.id
    Check 'follow-up saves with follows' ($b.Status -eq 201 -and $b.Json.follows -eq $idA)
    $origA = (Invoke-Api GET "/api/meetings/$idA").Json
    $byId = @{}; foreach ($x in $origA.actions) { $byId[$x.id] = $x }
    Check 'carried actions are marked in the original' ($byId['act1'].carried -eq $idB -and $byId['act3'].carried -eq $idB)
    Check 'done actions are not marked carried' (-not $byId['act2'].carried)
    Check 'marking carried keeps the original savedAt' ($origA.savedAt -eq $savedAtA)
    Check 'carried actions stop counting as open' ((Get-Summary $idA).openActions -eq 0 -and (Get-Summary $idA).overdueActions -eq 0)
    Check 'follow-up counts them instead' ((Get-Summary $idB).openActions -eq 2)

    $r = Invoke-Api PUT "/api/meetings/$idB" (@{
        follows = $idA
        fields  = @{ title = 'Crash triage v2'; type = 'triage'; date = $today }
        checks  = @{}
        actions = @(@{ id = 'act1'; a = 'Fix save crash'; o = 'Ana'; d = $past; t = 'GAME-1'; done = $false })
    } | ConvertTo-Json -Depth 5)
    $byId = @{}; foreach ($x in (Invoke-Api GET "/api/meetings/$idA").Json.actions) { $byId[$x.id] = $x }
    Check 'removing an action from the follow-up releases it' ($r.Status -eq 200 -and -not $byId['act3'].carried -and $byId['act1'].carried -eq $idB)

    $r = Invoke-Api DELETE "/api/meetings/$idB"
    $byId = @{}; foreach ($x in (Invoke-Api GET "/api/meetings/$idA").Json.actions) { $byId[$x.id] = $x }
    Check 'deleting the follow-up releases everything' ($r.Json.deleted -eq $idB -and -not $byId['act1'].carried -and -not $byId['act3'].carried)
    Check 'deleted meeting is gone' ((Invoke-Api GET "/api/meetings/$idB").Status -eq 404)
    Check 'original counts them as open again' ((Get-Summary $idA).openActions -eq 2)

    $r = Invoke-Api POST '/api/meetings' '{"follows":"no-such-meeting","fields":{"title":"x"},"checks":{},"actions":[]}'
    Check 'follows pointing nowhere is harmless' ($r.Status -eq 201)
    [void](Invoke-Api DELETE "/api/meetings/$($r.Json.id)")

    Write-Host 'Files on disk'
    $legacy = '{"fields":{"title":"Old v1.0 meeting","type":"standup","date":"2026-01-05"},"checks":{"before-0":true},"actions":[{"a":"old","o":"x","d":"","t":"","done":false}],"id":"20260105-090000-abcdef","savedAt":"2026-01-05T09:00:00"}'
    [System.IO.File]::WriteAllText((Join-Path $data '20260105-090000-abcdef.json'), $legacy, (New-Object System.Text.UTF8Encoding($false)))
    Check 'v1.0 file (no action ids) lists and opens' ((Get-Summary '20260105-090000-abcdef').openActions -eq 1 -and (Invoke-Api GET '/api/meetings/20260105-090000-abcdef').Status -eq 200)
    $files = @(Get-ChildItem -LiteralPath $data)
    Check 'no .tmp files left behind' (-not ($files | Where-Object { $_.Extension -eq '.tmp' }))
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $data "$idA.json"))
    Check 'saved files have no BOM' (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF))

    Write-Host 'Open actions across meetings'
    $r = Invoke-Api GET '/api/actions'
    $acts = @($r.Json)
    $fix = $acts | Where-Object { $_.id -eq 'act1' }
    Check 'GET /api/actions lists open actions only' ($r.Status -eq 200 -and $acts.Count -eq 3 -and -not ($acts | Where-Object { $_.a -eq 'Already done' })) "(got $($acts.Count))"
    Check 'each action names its meeting' ($fix.meetingId -eq $idA -and $fix.meeting -eq 'Crash triage v2' -and $fix.meetingDate -eq '2026-09-20' -and $fix.o -eq 'Ana' -and $fix.d -eq $past -and $fix.t -eq 'GAME-1')
    Check 'soonest due first, no due date last' ($acts[0].id -eq 'act1' -and -not $acts[1].d -and -not $acts[2].d)
    Check 'an action from before ids has an empty id' (($acts | Where-Object { $_.a -eq 'old' }).id -eq '')

    $savedAtA = (Invoke-Api GET "/api/meetings/$idA").Json.savedAt
    $r = Invoke-Api PUT "/api/meetings/$idA/actions/act3" '{"done":true}'
    $after = (Invoke-Api GET "/api/meetings/$idA").Json
    $byId = @{}; foreach ($x in $after.actions) { $byId[$x.id] = $x }
    Check 'PUT action done ticks just that action' ($r.Status -eq 200 -and $r.Json.done -eq $true -and $byId['act3'].done -eq $true -and $byId['act1'].done -eq $false -and @($after.actions).Count -eq 3 -and $after.fields.title -eq 'Crash triage v2')
    Check 'ticking an action keeps savedAt' ($after.savedAt -eq $savedAtA)
    Check 'a ticked action leaves the open list' (@((Invoke-Api GET '/api/actions').Json).Count -eq 2 -and (Get-Summary $idA).openActions -eq 1)
    $r = Invoke-Api PUT "/api/meetings/$idA/actions/act3" '{"done":false}'
    Check 'unticking puts it back' ($r.Json.done -eq $false -and (Get-Summary $idA).openActions -eq 2)
    Check 'unknown action -> 404'  ((Invoke-Api PUT "/api/meetings/$idA/actions/nope" '{"done":true}').Status -eq 404)
    Check 'action in an unknown meeting -> 404' ((Invoke-Api PUT '/api/meetings/does-not-exist/actions/act1' '{"done":true}').Status -eq 404)
    Check 'tick without X-Run-Sheet -> 403' ((Invoke-Api PUT "/api/meetings/$idA/actions/act1" '{"done":true}' @{ 'X-Run-Sheet' = '0' }).Status -eq 403)

    Write-Host 'Backup, restore and CSV'
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
    Check 'restore skips paths, bad ids and bad files' ($r.Json.added -eq 0 -and $r.Json.invalid -eq 6 -and @(Get-ChildItem -LiteralPath $data).Count -eq 2 -and -not (Test-Path (Join-Path $work 'escape.json'))) "($($r.Json | ConvertTo-Json -Compress))"

    $c = Invoke-Api POST '/api/meetings' (@{
        fields  = @{ title = 'CSV, "quoted"'; type = 'general'; date = '2026-01-01' }
        checks  = @{}
        actions = @(@{ id = 'x1'; a = '=HYPERLINK("x")'; o = 'Bo'; d = ''; t = ''; done = $false })
    } | ConvertTo-Json -Depth 5)
    $r = Invoke-Raw GET '/api/actions.csv'
    Check 'actions CSV is a download with a BOM' ($r.Status -eq 200 -and $r.Type -like 'text/csv*' -and $r.Disposition -match 'attachment; filename="meeting-actions-' -and $r.Bytes[0] -eq 0xEF)
    $rows = @([System.Text.Encoding]::UTF8.GetString($r.Bytes).TrimStart([char]0xFEFF) -split "`r`n" | Where-Object { $_ } | ConvertFrom-Csv)
    $fix = $rows | Where-Object { $_.Action -eq 'Fix save crash' }
    Check 'CSV lists every action with its status' ($rows.Count -eq 5 -and $fix.Status -eq 'overdue' -and $fix.Owner -eq 'Ana' -and $fix.Ticket -eq 'GAME-1' -and $fix.Meeting -eq 'Crash triage v2' -and ($rows | Where-Object { $_.Action -eq 'Already done' }).Status -eq 'done') "(got $($rows.Count) rows)"
    $odd = $rows | Where-Object { $_.'Meeting id' -eq $c.Json.id }
    Check 'CSV quotes text and defuses formulas' ($odd.Meeting -eq 'CSV, "quoted"' -and $odd.Action -eq "'=HYPERLINK(`"x`")") "(got $($odd.Meeting) / $($odd.Action))"
    [void](Invoke-Api DELETE "/api/meetings/$($c.Json.id)")

    Write-Host 'Calendar and readiness'
    # Two meetings on the same day next week: one prepared, one not. They stay for the page checks.
    $next = (Get-Date).AddDays(7).ToString('yyyy-MM-dd')
    $u1 = (Invoke-Api POST '/api/meetings' (@{
        fields  = @{ title = 'Prepared review'; type = 'design'; date = $next; time = '14:00'; goal = 'approve or rework' }
        checks  = @{ 'before:send-agenda' = $true; 'before:prep-room' = $true; 'during:start-on-time' = $true }
        agenda  = @(@{ t = 'Risks'; m = 20 })
        actions = @()
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
        function Get-Dom([string]$Url, [string]$Name) {
            $domFile = Join-Path $work "$Name.html"
            $edgeArgs = "--headless --disable-gpu --no-first-run --user-data-dir=`"$work\edge-$Name`" --virtual-time-budget=4000 --dump-dom $Url"
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
        Check 'type dropdown has 8 types'         ((& $count '<option value=') -eq 8)
        Check 'help tooltips are built (7)'       ((& $count 'class="label-row') -eq 7)
        Check 'sidebar lists saved meetings'      ($dom -match 'Crash triage v2')
        Check 'overdue badge shows in the list'   ($dom -match '1 overdue')
        Check 'timer bar is present and hidden'   ($dom -match 'id="timerBar"[^>]*hidden')
        Check 'agenda editor shows one empty row' ((& $count 'id="ag-t-') -eq 1)
        Check 'attendee list shows one empty row' ((& $count 'id="att-') -eq 1)
        Check 'menu has backup, restore and CSV'  ($dom -match 'id="backupBtn"' -and $dom -match 'id="restoreBtn"' -and $dom -match 'id="csvBtn"')
        Check 'calendar grid has 42 days'         ((& $count 'class="day') -eq 42) "(got $(& $count 'class="day'))"
        Check 'list has Upcoming and Past groups' ($dom -match '<div class="group">Upcoming</div>' -and $dom -match '<div class="group">Past</div>')
        Check 'readiness badges show'             ($dom -match 'class="pill ready">Ready<' -and $dom -match 'class="pill prep">Needs goal, agenda, prep 1/2<')
        Check 'start time field is present'       ($dom -match 'id="f-time"')
        Check 'section nav lists 6 sections'     ((& $count 'class="jump-link') -eq 6) "(got $(& $count 'class="jump-link'))"
        Check 'empty agenda offers the type template' ($dom -match 'id="useTemplate"[^>]*>Use template: General / decision<' -and $dom -notmatch 'id="useTemplate"[^>]*hidden')
        Check 'owner boxes use the suggestion list' ($dom -match '<datalist id="ownerList">' -and $dom -match 'id="act-o-0"[^>]*list="ownerList"')
        Check 'Actions button counts open actions' ($dom -match 'id="actionsCount"[^>]*>3<' -and $dom -match 'id="actionsView"[^>]*hidden')

        # The open actions view: /#actions opens it instead of the run sheet.
        $dom = Get-Dom "$base/#actions" 'actions'
        Check 'actions view replaces the run sheet' ($dom -match 'id="sheet"[^>]*hidden' -and $dom -notmatch 'id="actionsView"[^>]*hidden')
        Check 'actions view groups by due date'     ((& $count 'class="grp"') -eq 2 -and $dom -match '>Overdue <' -and $dom -match '>No due date <') "(got $(& $count 'class="grp"') groups)"
        Check 'actions view lists actions with a tick box' ($dom -match '<td class="a">Fix save crash</td>' -and (& $count 'aria-label="Done: ') -eq 2) "(got $(& $count 'aria-label="Done: ') boxes)"
    }
} finally {
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
