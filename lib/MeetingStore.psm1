# MeetingStore: one JSON file per meeting in a data folder.
#
#   $store = [MeetingStore]::new('D:\Notes\Meetings')
#   $store.List('crash')                       # summaries, newest first
#   $store.Exists($id); $store.ReadRaw($id)
#   $store.Create($json); $store.Update($json, $id); $store.Remove($id)
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

    # Summaries for the sidebar: {id,title,date,type,savedAt,openActions,overdueActions}, newest first.
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
            $items.Add([pscustomobject]@{
                id             = [System.IO.Path]::GetFileNameWithoutExtension($file)
                title          = $m.fields.title
                date           = $m.fields.date
                type           = $m.fields.type
                savedAt        = $m.savedAt
                openActions    = $open.Count
                overdueActions = @($open | Where-Object { $_.d -and [MeetingStore]::DayText($_.d) -lt $today }).Count
            })
        }
        return @($items | Sort-Object -Property @{ Expression = { "$($_.date)" }; Descending = $true },
                                                @{ Expression = { "$($_.savedAt)" }; Descending = $true })
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
