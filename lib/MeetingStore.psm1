# MeetingStore: one JSON file per meeting in a data folder.
#
#   $store = [MeetingStore]::new('D:\Notes\Meetings')
#   $store.List('crash')        # summaries, newest first
#   $store.Exists($id); $store.ReadRaw($id); $store.Save($json, $id); $store.Delete($id)
#
# Files are UTF-8 without BOM and written temp-then-move, so a crash never leaves
# a half-written meeting.

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

    [string] PathOf([string] $id) {
        return [System.IO.Path]::Combine($this.Root, "$id.json")
    }

    [bool] Exists([string] $id) {
        return [System.IO.File]::Exists($this.PathOf($id))
    }

    [string] ReadRaw([string] $id) {
        return [System.IO.File]::ReadAllText($this.PathOf($id), $this.Utf8)
    }

    [void] Delete([string] $id) {
        [System.IO.File]::Delete($this.PathOf($id))
    }

    # Saves the meeting JSON sent by the page. Pass an empty id to create a new meeting.
    # The store owns "id" and "savedAt"; any values sent by the page are overwritten.
    [object] Save([string] $json, [string] $id) {
        $meeting = $json | ConvertFrom-Json
        if (-not $id) { $id = [MeetingStore]::NewId() }
        $meeting | Add-Member -NotePropertyName id      -NotePropertyValue $id -Force
        $meeting | Add-Member -NotePropertyName savedAt -NotePropertyValue ((Get-Date).ToString('s')) -Force

        $path = $this.PathOf($id)
        $tmp  = "$path.tmp"
        [System.IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $meeting -Depth 10), $this.Utf8)
        Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction Stop
        return $meeting
    }

    # Summaries for the sidebar: {id,title,date,type,savedAt,openActions}, newest first.
    # $query is a case-insensitive substring match on the raw file text.
    [object[]] List([string] $query) {
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($file in [System.IO.Directory]::GetFiles($this.Root, '*.json')) {
            $raw = [System.IO.File]::ReadAllText($file, $this.Utf8)
            if ($query -and $raw.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
            try { $m = $raw | ConvertFrom-Json } catch { continue }   # skip unreadable files

            $items.Add([pscustomobject]@{
                id          = [System.IO.Path]::GetFileNameWithoutExtension($file)
                title       = $m.fields.title
                date        = $m.fields.date
                type        = $m.fields.type
                savedAt     = $m.savedAt
                openActions = @($m.actions | Where-Object { $_.a -and -not $_.done }).Count
            })
        }
        return @($items | Sort-Object -Property @{ Expression = { "$($_.date)" }; Descending = $true },
                                                @{ Expression = { "$($_.savedAt)" }; Descending = $true })
    }
}
