# MeetingStore: one JSON file per meeting in a data folder.
#
#   $store = [MeetingStore]::new('D:\Notes\Meetings')
#   $store.List('crash')                       # summaries, newest first
#   $store.Exists($id); $store.ReadRaw($id)
#   $store.Create($json); $store.Update($json, $id); $store.Remove($id)
#   $store.ListDeleted(); $store.Restore($id)  # put a deleted meeting back
#   $store.BackupZip(); $store.RestoreZip($bytes); $store.AutoBackup(10)
#   $store.ListBackups(); $store.RestoreBackup($name)
#   $store.ReadSettings(); $store.WriteSettings($json)
#
# Inside the data folder: deleted\ (meetings removed with Remove), backups\ (AutoBackup zips)
# and settings\ (page settings). Only <id>.json files at the top level are meetings.
#
# Files are UTF-8 without BOM and written temp-then-move, so a crash never leaves
# a half-written meeting.
#
# The store keeps whatever the page sends. Actions in files from before v1.23.0 can have a due
# date, ticket, "done" and "carried"; nothing here reads them (tracking actions is out of scope).

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

    # A savedAt value as text (see DayText).
    static [string] StampText([object] $value) {
        if ($value -is [datetime]) { return $value.ToString('yyyy-MM-ddTHH:mm:ss.fff') }
        return [string]$value
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
        return $this.Save(($json | ConvertFrom-Json), [MeetingStore]::NewId())
    }

    # Returns $null, and writes nothing, when the page's copy is out of date: the page sends the
    # savedAt it opened the meeting with, and the file has a different one (it was saved from
    # another tab or window since). A body without savedAt is always written.
    [object] Update([string] $json, [string] $id) {
        $meeting = $json | ConvertFrom-Json
        if ($meeting.savedAt -and [MeetingStore]::StampText($meeting.savedAt) -ne [MeetingStore]::StampText($this.Read($id).savedAt)) {
            return $null
        }
        return $this.Save($meeting, $id)
    }

    # Deleting moves the file to the "deleted" folder inside the data folder, so a meeting deleted
    # by mistake can be put back by hand. Deleting the same id again replaces the earlier copy.
    [void] Remove([string] $id) {
        $bin = [System.IO.Path]::Combine($this.Root, 'deleted')
        [void][System.IO.Directory]::CreateDirectory($bin)
        $to = [System.IO.Path]::Combine($bin, "$id.json")
        if ([System.IO.File]::Exists($to)) { [System.IO.File]::Delete($to) }
        [System.IO.File]::Move($this.PathOf($id), $to)
    }

    # ---- Bringing meetings back ----

    hidden [string] DeletedPath([string] $id) {
        return [System.IO.Path]::Combine($this.Root, 'deleted', "$id.json")
    }

    [bool] IsDeleted([string] $id) {
        return [System.IO.File]::Exists($this.DeletedPath($id))
    }

    # The meetings in the "deleted" folder as {id,title,date,time,type}, newest first. One whose id
    # is a meeting again (it came back from a backup) is left out: there is nothing to put back.
    [object[]] ListDeleted() {
        $items = New-Object System.Collections.Generic.List[object]
        $bin = [System.IO.Path]::Combine($this.Root, 'deleted')
        if (-not [System.IO.Directory]::Exists($bin)) { return @() }
        foreach ($file in [System.IO.Directory]::GetFiles($bin, '*.json')) {
            $id = [System.IO.Path]::GetFileNameWithoutExtension($file)
            if (-not [MeetingStore]::IsValidId($id) -or $this.Exists($id)) { continue }
            $m = $null
            try { $m = [System.IO.File]::ReadAllText($file, $this.Utf8) | ConvertFrom-Json } catch { }
            if (-not $m) { continue }   # skip unreadable files
            $items.Add([pscustomobject]@{
                id    = $id
                title = $m.fields.title
                date  = [MeetingStore]::DayText($m.fields.date)
                time  = [string]$m.fields.time
                type  = $m.fields.type
            })
        }
        return @($items | Sort-Object -Property @{ Expression = { "$($_.date)" }; Descending = $true },
                                                @{ Expression = { "$($_.time)" }; Descending = $true })
    }

    # Moves a deleted meeting back, as it was. Returns $false, and moves nothing, when a meeting
    # with that id is here. Callers check IsDeleted first.
    [bool] Restore([string] $id) {
        if ($this.Exists($id)) { return $false }
        [System.IO.File]::Move($this.DeletedPath($id), $this.PathOf($id))
        return $true
    }

    # Backup names come from URLs, so callers must check them with this first.
    static [bool] IsBackupName([string] $name) {
        return $name -match '^meetings-\d{8}-\d{6}\.zip$'
    }

    hidden [string] BackupPath([string] $name) {
        return [System.IO.Path]::Combine($this.Root, 'backups', $name)
    }

    [bool] HasBackup([string] $name) {
        return [System.IO.File]::Exists($this.BackupPath($name))
    }

    # The startup backups as {name, at, count}, newest first: "at" is when it was made
    # ("yyyy-MM-dd HH:mm", from the name) and "count" the number of files in the zip.
    [object[]] ListBackups() {
        Add-Type -AssemblyName System.IO.Compression
        $items = New-Object System.Collections.Generic.List[object]
        $dir = [System.IO.Path]::Combine($this.Root, 'backups')
        if (-not [System.IO.Directory]::Exists($dir)) { return @() }
        foreach ($file in @([System.IO.Directory]::GetFiles($dir, 'meetings-*.zip') | Sort-Object -Descending)) {
            $name = [System.IO.Path]::GetFileName($file)
            $m = [regex]::Match($name, '^meetings-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)\d\d\.zip$')
            if (-not $m.Success) { continue }
            $count = -1
            $zip = $null   # 5.1 classes reject a variable that is only assigned inside try
            $stream = [System.IO.File]::OpenRead($file)
            try {
                $zip = New-Object System.IO.Compression.ZipArchive($stream, 'Read', $true)
                $count = $zip.Entries.Count
            } catch {
            } finally {
                if ($zip) { $zip.Dispose() }
                $stream.Dispose()
            }
            if ($count -lt 0) { continue }   # not a readable zip
            $g = $m.Groups
            $items.Add([pscustomobject]@{
                name  = $name
                at    = "$($g[1].Value)-$($g[2].Value)-$($g[3].Value) $($g[4].Value):$($g[5].Value)"
                count = $count
            })
        }
        return $items.ToArray()
    }

    # Adds the meetings in a startup backup that are missing here (see RestoreZip).
    # Callers check IsBackupName and HasBackup first.
    [object] RestoreBackup([string] $name) {
        return $this.RestoreZip([System.IO.File]::ReadAllBytes($this.BackupPath($name)))
    }

    # Summaries for the sidebar: {id,title,date,time,type,savedAt,series,hasGoal,agendaCount,beforeChecks},
    # newest first (by date, then start time).
    # $query is a case-insensitive substring match on the raw file text.
    [object[]] List([string] $query) {
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($file in [System.IO.Directory]::GetFiles($this.Root, '*.json')) {
            $raw = [System.IO.File]::ReadAllText($file, $this.Utf8)
            if ($query -and $raw.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
            try { $m = $raw | ConvertFrom-Json } catch { continue }   # skip unreadable files

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
                # Shared by the meetings planned together with Repeat weekly; '' for any other.
                series         = [string]$m.series
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

    # ---- Backup and restore ----
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
    # names are only ever matched against the id pattern, never used as paths. An entry over 5 MB
    # is invalid, and so is anything past 500 MB of restored text in one call.
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
        $budget = 500MB   # text restored in one go, so a small zip can't unpack into a full disk
        $chunk = New-Object char[] 65536
        try {
            foreach ($entry in $zip.Entries) {
                if (-not $entry.Name) { continue }   # a folder
                $m = [regex]::Match($entry.FullName, '^([A-Za-z0-9-]{1,64})\.json$')
                if (-not $m.Success -or $entry.Length -gt 5MB) { $invalid++; continue }
                $id = $m.Groups[1].Value
                if ($this.Exists($id)) { $skipped++; continue }

                # Read with our own limit: the size a zip states for an entry can be a lie.
                $sb = New-Object System.Text.StringBuilder
                $n = 0   # 5.1 classes reject a variable that is only assigned inside try
                $reader = New-Object System.IO.StreamReader($entry.Open(), $this.Utf8)
                try {
                    while ($sb.Length -le 5MB -and ($n = $reader.Read($chunk, 0, $chunk.Length)) -gt 0) {
                        [void]$sb.Append($chunk, 0, $n)
                    }
                } finally { $reader.Dispose() }
                if ($sb.Length -gt 5MB -or $sb.Length -gt $budget) { $invalid++; continue }
                $budget -= $sb.Length
                $text = $sb.ToString()
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

    # Writes a backup zip into the "backups" folder inside the data folder and keeps the newest
    # $keep of them. Called once at startup. Returns the zip's path, or '' when there are no
    # meetings yet.
    [string] AutoBackup([int] $keep) {
        if ([System.IO.Directory]::GetFiles($this.Root, '*.json').Length -eq 0) { return '' }
        $dir = [System.IO.Path]::Combine($this.Root, 'backups')
        [void][System.IO.Directory]::CreateDirectory($dir)
        $path = [System.IO.Path]::Combine($dir, 'meetings-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
        [System.IO.File]::WriteAllBytes($path, $this.BackupZip())
        # The names sort by date, so the oldest are the ones past the first $keep.
        $old = @([System.IO.Directory]::GetFiles($dir, 'meetings-*.zip') | Sort-Object -Descending | Select-Object -Skip $keep)
        foreach ($file in $old) { [System.IO.File]::Delete($file) }
        return $path
    }

    # ---- Page settings ----
    # The theme and the sidebar choice, in "settings\page.json" inside the data folder (a subfolder,
    # so the file is never taken for a meeting). Only the known keys are kept.

    [string] ReadSettings() {
        $path = [System.IO.Path]::Combine($this.Root, 'settings', 'page.json')
        if (-not [System.IO.File]::Exists($path)) { return '{}' }
        return [System.IO.File]::ReadAllText($path, $this.Utf8)
    }

    # Returns the settings as stored. "theme" is always written ('' = follow the system), which is
    # how the page tells "nothing stored yet" from "stored".
    [string] WriteSettings([string] $json) {
        $sent = $json | ConvertFrom-Json
        $theme = ''
        if ($sent.theme -is [string] -and $sent.theme -match '^[a-z]{1,20}$') { $theme = $sent.theme }
        $text = ConvertTo-Json -InputObject ([ordered]@{ theme = $theme; sideOff = ($sent.sideOff -eq $true) }) -Compress
        $dir = [System.IO.Path]::Combine($this.Root, 'settings')
        [void][System.IO.Directory]::CreateDirectory($dir)
        $path = [System.IO.Path]::Combine($dir, 'page.json')
        [System.IO.File]::WriteAllText("$path.tmp", $text, $this.Utf8)
        Move-Item -LiteralPath "$path.tmp" -Destination $path -Force -ErrorAction Stop
        return $text
    }

    # ---- Internals ----

    # Writes a meeting sent by the page under $id.
    # The store owns "id" and "savedAt"; any values sent by the page are overwritten.
    hidden [object] Save([object] $meeting, [string] $id) {
        $meeting | Add-Member -NotePropertyName id      -NotePropertyValue $id -Force
        # To the millisecond, so Update can tell two saves in the same second apart.
        $meeting | Add-Member -NotePropertyName savedAt -NotePropertyValue ((Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fff')) -Force
        $this.Write($id, $meeting)
        return $meeting
    }

    # The file is always named after $id, never after the "id" inside the meeting: a restored or
    # hand-copied file can have none, or one that names another meeting.
    hidden [void] Write([string] $id, [object] $meeting) {
        $meeting | Add-Member -NotePropertyName id -NotePropertyValue $id -Force
        $path = $this.PathOf($id)
        $tmp  = "$path.tmp"
        [System.IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $meeting -Depth 10), $this.Utf8)
        Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction Stop
    }
}
