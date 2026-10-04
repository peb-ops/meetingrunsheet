# MeetingStore: one JSON file per meeting in a data folder.
#
#   $store = [MeetingStore]::new('D:\Notes\Meetings')
#   $store.List('crash')                       # summaries, newest first
#   $store.Exists($id); $store.ReadRaw($id)
#   $store.Create($json); $store.Update($json, $id); $store.Remove($id)
#   $store.BackupZip(); $store.RestoreZip($bytes); $store.ActionsCsv()
#   $store.OpenActions(); $store.SetActionDone($id, $actionId, $true)
#
# Files are UTF-8 without BOM and written temp-then-move, so a crash never leaves
# a half-written meeting.
#
# Follow-ups: a meeting with "follows": "<id>" carries open actions over from that meeting
# (same action "id"). On every save, the matching actions in the original get
# "carried": "<follow-up id>" so they stop counting as open; actions removed from the
# follow-up, or a deleted follow-up, release them again.

class MeetingStore {
    [string] $Root
    hidden [System.Text.Encoding] $Utf8 = (New-Object System.Text.UTF8Encoding($false))

    MeetingStore([string] $root) {
        if (-not [System.IO.Directory]::Exists($root)) {
            [void][System.IO.Directory]::CreateDirectory($root)
        }
        $this.Root = [System.IO.Path]::GetFullPath($root)
    }

    # Ids come from URLs, so callers must check them with IsValidId first.
    static [bool] IsValidId([string] $id) {
        return $id -match '^[A-Za-z0-9-]{1,64}$'
    }

    static [string] NewId() {
        return (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    }

    # A date value as "yyyy-MM-dd". PowerShell 7's ConvertFrom-Json may already have turned it into a DateTime.
    static [string] DayText([object] $value) {
        if ($value -is [datetime]) { return $value.ToString('yyyy-MM-dd') }
        return [string]$value
    }

    # Open = has text, not done, not carried to a follow-up.
    static [bool] IsOpen([object] $action) {
        return [bool]($action.a -and -not $action.done -and -not $action.carried)
    }

    [string] PathOf([string] $id) {
        return [System.IO.Path]::Combine($this.Root, "$id.json")
    }

    [bool] Exists([string] $id) {
        return [System.IO.File]::Exists($this.PathOf($id))
    }

    [string] ReadRaw([string] $id) {
        return [System.IO.File]::ReadAllText($this.PathOf($id), $this.Utf8)
    }

    [object] Read([string] $id) {
        return $this.ReadRaw($id) | ConvertFrom-Json
    }

    # ---- Commands used by the API ----

    [object] Create([string] $json) {
        $meeting = $this.Save($json, [MeetingStore]::NewId())
        $this.SyncCarried($meeting)
        return $meeting
    }

    [object] Update([string] $json, [string] $id) {
        $meeting = $this.Save($json, $id)
        $this.SyncCarried($meeting)
        return $meeting
    }

    [void] Remove([string] $id) {
        $meeting = $this.Read($id)
        [System.IO.File]::Delete($this.PathOf($id))
        # Treat it as a follow-up with no actions, so everything carried to it is released.
        $meeting | Add-Member -NotePropertyName actions -NotePropertyValue @() -Force
        $this.SyncCarried($meeting)
    }

    # Summaries for the sidebar: {id,title,date,time,type,savedAt,openActions,overdueActions,
    # hasGoal,agendaCount,beforeChecks}, newest first (by date, then start time).
    # $query is a case-insensitive substring match on the raw file text.
    [object[]] List([string] $query) {
        $today = (Get-Date).ToString('yyyy-MM-dd')
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($file in [System.IO.Directory]::GetFiles($this.Root, '*.json')) {
            $raw = [System.IO.File]::ReadAllText($file, $this.Utf8)
            if ($query -and $raw.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
            try { $m = $raw | ConvertFrom-Json } catch { continue }   # skip unreadable files

            # Due dates are "yyyy-MM-dd", so they compare as strings.
            $open = @($m.actions | Where-Object { [MeetingStore]::IsOpen($_) })
            # Agenda rows with text or minutes; before v1.3.0 the agenda was lines of text in fields.agenda.
            $agendaCount = @($m.agenda | Where-Object { $_.t -or $_.m }).Count
            if ($null -eq $m.agenda -and $m.fields.agenda) {
                $agendaCount = @(([string]$m.fields.agenda) -split "`n" | Where-Object { $_.Trim() }).Count
            }
            $items.Add([pscustomobject]@{
                id             = [System.IO.Path]::GetFileNameWithoutExtension($file)
                title          = $m.fields.title
                date           = [MeetingStore]::DayText($m.fields.date)
                time           = [string]$m.fields.time
                type           = $m.fields.type
                savedAt        = $m.savedAt
                openActions    = $open.Count
                overdueActions = @($open | Where-Object { $_.d -and [MeetingStore]::DayText($_.d) -lt $today }).Count
                # For the "Ready / Needs ..." badge on upcoming meetings (see readiness() in app.js).
                hasGoal        = [bool]([string]$m.fields.goal).Trim()
                agendaCount    = $agendaCount
                beforeChecks   = [MeetingStore]::CheckedIn($m.checks, 'before')
            })
        }
        return @($items | Sort-Object -Property @{ Expression = { "$($_.date)" }; Descending = $true },
                                                @{ Expression = { "$($_.time)" }; Descending = $true },
                                                @{ Expression = { "$($_.savedAt)" }; Descending = $true })
    }

    # Item ids ticked in one checklist phase: checks {"before:send-agenda": true} -> @('send-agenda').
    static [string[]] CheckedIn([object] $checks, [string] $phase) {
        $ids = New-Object System.Collections.Generic.List[string]
        if ($checks) {
            foreach ($p in $checks.PSObject.Properties) {
                if ($p.Name.StartsWith("${phase}:") -and $p.Value -eq $true) { $ids.Add($p.Name.Substring($phase.Length + 1)) }
            }
        }
        return $ids.ToArray()
    }

    # ---- Backup, restore and export ----
    # Zip types are named as strings (New-Object), not [type] literals: Windows PowerShell 5.1
    # resolves literals when the class is parsed, before Add-Type has loaded the assembly.

    # Every meeting file in one zip, as stored (<id>.json at the top level).
    [byte[]] BackupZip() {
        Add-Type -AssemblyName System.IO.Compression
        $buffer = New-Object System.IO.MemoryStream
        $zip = New-Object System.IO.Compression.ZipArchive($buffer, 'Create', $true)
        try {
            foreach ($file in [System.IO.Directory]::GetFiles($this.Root, '*.json')) {
                $bytes = [System.IO.File]::ReadAllBytes($file)
                $entry = $zip.CreateEntry([System.IO.Path]::GetFileName($file))
                $stream = $entry.Open()
                try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
            }
        } finally {
            $zip.Dispose()   # writes the zip's directory, so it must happen before ToArray
        }
        return $buffer.ToArray()
    }

    # Adds the meetings in a backup zip. Never overwrites: an id that is already here is skipped.
    # Only top-level "<id>.json" entries with a valid id and a readable meeting are used, and entry
    # names are only ever matched against the id pattern, never used as paths.
    # Returns {added, skipped, invalid}, or $null if the bytes aren't a zip.
    [object] RestoreZip([byte[]] $bytes) {
        Add-Type -AssemblyName System.IO.Compression
        if ($bytes.Length -lt 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) { return $null }   # "PK"
        $zip = $null
        try {
            $zip = New-Object System.IO.Compression.ZipArchive((New-Object System.IO.MemoryStream(, $bytes)), 'Read')
        } catch {
            return $null
        }
        $added = 0; $skipped = 0; $invalid = 0
        try {
            foreach ($entry in $zip.Entries) {
                if (-not $entry.Name) { continue }   # a folder
                $m = [regex]::Match($entry.FullName, '^([A-Za-z0-9-]{1,64})\.json$')
                if (-not $m.Success -or $entry.Length -gt 5MB) { $invalid++; continue }
                $id = $m.Groups[1].Value
                if ($this.Exists($id)) { $skipped++; continue }

                $text = ''   # 5.1 classes reject a variable that is only assigned inside try
                $reader = New-Object System.IO.StreamReader($entry.Open(), $this.Utf8)
                try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
                $meeting = $null
                try { $meeting = $text | ConvertFrom-Json } catch { }
                if (-not $meeting -or -not $meeting.fields -or ($meeting.id -and [string]$meeting.id -ne $id)) { $invalid++; continue }

                $path = $this.PathOf($id)
                [System.IO.File]::WriteAllText("$path.tmp", $text, $this.Utf8)
                Move-Item -LiteralPath "$path.tmp" -Destination $path -Force -ErrorAction Stop
                $added++
            }
        } finally {
            $zip.Dispose()
        }
        return [pscustomobject]@{ added = $added; skipped = $skipped; invalid = $invalid }
    }

    # Every action in every meeting as CSV text, newest meeting first.
    # Status is open, overdue, done or carried (moved to a follow-up meeting).
    [string] ActionsCsv() {
        $today = (Get-Date).ToString('yyyy-MM-dd')
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append("Meeting date,Meeting,Action,Owner,Due,Ticket,Status,Meeting id`r`n")
        foreach ($s in $this.List('')) {
            $m = $this.Read($s.id)
            foreach ($a in @($m.actions)) {
                if (-not $a.a) { continue }
                $due = [MeetingStore]::DayText($a.d)
                $status = 'open'
                if ($a.done) { $status = 'done' }
                elseif ($a.carried) { $status = 'carried' }
                elseif ($due -and $due -lt $today) { $status = 'overdue' }
                $cells = foreach ($v in @([MeetingStore]::DayText($s.date), $s.title, $a.a, $a.o, $due, $a.t, $status, $s.id)) {
                    [MeetingStore]::CsvCell($v)
                }
                [void]$sb.Append(($cells -join ',') + "`r`n")
            }
        }
        return $sb.ToString()
    }

    # One quoted CSV value. Text starting with = + - @ (or a tab / CR) gets a leading ' so
    # Excel shows it instead of running it as a formula.
    static [string] CsvCell([object] $value) {
        $text = [string]$value
        if ($text -match '^[=+\-@\t\r]') { $text = "'" + $text }
        return '"' + $text.Replace('"', '""') + '"'
    }

    # ---- Actions across meetings ----

    # Every open action in every meeting, soonest due first (no due date last):
    # {meetingId, meeting, meetingDate, id, a, o, d, t}. "id" is '' in files from before v1.2.0
    # that haven't been saved since, so those can't be ticked off with SetActionDone.
    [object[]] OpenActions() {
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($s in $this.List('')) {
            $m = $this.Read($s.id)
            foreach ($a in @($m.actions | Where-Object { [MeetingStore]::IsOpen($_) })) {
                $items.Add([pscustomobject]@{
                    meetingId   = $s.id
                    meeting     = [string]$s.title
                    meetingDate = $s.date
                    id          = [string]$a.id
                    a           = [string]$a.a
                    o           = [string]$a.o
                    d           = [MeetingStore]::DayText($a.d)
                    t           = [string]$a.t
                })
            }
        }
        return @($items | Sort-Object -Property @{ Expression = { if ($_.d) { $_.d } else { '9999' } } },
                                                @{ Expression = { "$($_.meetingDate)" } })
    }

    # Ticks (or unticks) one action and leaves the rest of the meeting as it is. Like SyncCarried,
    # this doesn't change savedAt. Returns $false if the meeting has no action with that id.
    [bool] SetActionDone([string] $id, [string] $actionId, [bool] $done) {
        $meeting = $this.Read($id)
        $action = @($meeting.actions | Where-Object { $_.id -and [string]$_.id -eq $actionId }) | Select-Object -First 1
        if (-not $action) { return $false }
        $action | Add-Member -NotePropertyName done -NotePropertyValue $done -Force
        $this.Write($meeting)
        return $true
    }

    # ---- Internals ----

    # Parses the meeting JSON sent by the page and writes it under $id.
    # The store owns "id" and "savedAt"; any values sent by the page are overwritten.
    hidden [object] Save([string] $json, [string] $id) {
        $meeting = $json | ConvertFrom-Json
        $meeting | Add-Member -NotePropertyName id      -NotePropertyValue $id -Force
        $meeting | Add-Member -NotePropertyName savedAt -NotePropertyValue ((Get-Date).ToString('s')) -Force
        $this.Write($meeting)
        return $meeting
    }

    hidden [void] Write([object] $meeting) {
        $path = $this.PathOf($meeting.id)
        $tmp  = "$path.tmp"
        [System.IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $meeting -Depth 10), $this.Utf8)
        Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction Stop
    }

    # Marks the original meeting's actions carried to $followUp if they are still in it,
    # and releases ones that aren't. Writes the original only if something changed
    # (without touching its savedAt, so the list order stays put).
    hidden [void] SyncCarried([object] $followUp) {
        $fromId = [string]$followUp.follows
        if (-not [MeetingStore]::IsValidId($fromId) -or $fromId -eq $followUp.id -or -not $this.Exists($fromId)) { return }

        $ids = @($followUp.actions | Where-Object { $_.id } | ForEach-Object { [string]$_.id })
        $original = $this.Read($fromId)
        $changed = $false
        foreach ($a in @($original.actions)) {
            $carriedHere = $a.carried -and [string]$a.carried -eq $followUp.id
            $inFollowUp  = $a.id -and $ids -contains [string]$a.id
            if ($inFollowUp -and -not $carriedHere -and -not $a.carried -and -not $a.done) {
                $a | Add-Member -NotePropertyName carried -NotePropertyValue $followUp.id -Force
                $changed = $true
            } elseif ($carriedHere -and -not $inFollowUp) {
                $a.PSObject.Properties.Remove('carried')
                $changed = $true
            }
        }
        if ($changed) { $this.Write($original) }
    }
}
