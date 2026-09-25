# WebRoot: serves the page's static files (index.html, styles.css, *.js) from a folder.
#
#   $web  = [WebRoot]::new('...\web')
#   $file = $web.Find('/styles.css')   # $null if missing or not allowed
#   $file.Bytes; $file.ContentType
#
# Files are read from disk on every request, so UI edits show up on a browser refresh.

class WebRoot {
    [string] $Root

    # Only these file types are served; anything else is a 404.
    static [hashtable] $ContentTypes = @{
        '.html' = 'text/html; charset=utf-8'
        '.css'  = 'text/css; charset=utf-8'
        '.js'   = 'text/javascript; charset=utf-8'
        '.json' = 'application/json; charset=utf-8'
        '.svg'  = 'image/svg+xml'
        '.png'  = 'image/png'
        '.ico'  = 'image/x-icon'
    }

    WebRoot([string] $root) {
        $full = [System.IO.Path]::GetFullPath($root)
        if (-not [System.IO.File]::Exists([System.IO.Path]::Combine($full, 'index.html'))) {
            throw "Page files not found: $full\index.html. Keep the 'web' folder next to MeetingRunSheet.ps1."
        }
        $this.Root = $full.TrimEnd('\') + '\'
    }

    # Maps a URL path to a file under Root. "/" is index.html.
    # Returns @{ Bytes; ContentType }, or $null for anything missing, outside Root, or of an unknown type.
    [hashtable] Find([string] $urlPath) {
        $relative = [System.Uri]::UnescapeDataString($urlPath).TrimStart('/')
        if (-not $relative) { $relative = 'index.html' }

        try {
            $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($this.Root, $relative))
        } catch {
            return $null   # characters that aren't valid in a Windows path
        }
        if (-not $full.StartsWith($this.Root, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }

        $type = [WebRoot]::ContentTypes[[System.IO.Path]::GetExtension($full).ToLowerInvariant()]
        if (-not $type -or -not [System.IO.File]::Exists($full)) { return $null }

        return @{ Bytes = [System.IO.File]::ReadAllBytes($full); ContentType = $type }
    }
}
