using module .\MeetingStore.psm1
using module .\WebRoot.psm1

# RunSheetServer: the localhost HTTP server. Serves the page from a WebRoot and the
# meetings API from a MeetingStore.
#
#   $server = [RunSheetServer]::new(8080, $store, $web)
#   $server.Start()   # throws if the port is taken
#   $server.Run()     # blocks until Ctrl+C
#
# API (all JSON; non-GET requests must send header "X-Run-Sheet: 1"):
#   GET    /api/meetings?q=    summaries, newest first
#   POST   /api/meetings       create
#   GET    /api/meetings/{id}  read
#   PUT    /api/meetings/{id}  update; 409 if the body's savedAt isn't the file's (saved elsewhere since)
#   DELETE /api/meetings/{id}  delete (the file moves to the "deleted" folder)
#   GET    /api/settings       page settings {theme, sideOff}, or {} when none are stored
#   PUT    /api/settings       store page settings
#   GET    /api/backup         zip of every meeting file (download)
#   POST   /api/backup         restore: body is a backup zip; adds missing meetings, never overwrites
# Request bodies are capped (MaxBody, MaxBackup); a bigger one gets 413.

# Thrown by ReadBytes when a request body is over its limit; Handle answers it with 413.
class RequestTooLarge : System.Exception {
    RequestTooLarge([string] $message) : base($message) { }
}

class RunSheetServer {
    [int] $Port
    [string] $Prefix
    [MeetingStore] $Store
    [WebRoot] $Web
    static [long] $MaxBody   = 5MB     # one meeting as JSON
    static [long] $MaxBackup = 100MB   # a backup zip
    hidden [System.Net.HttpListener] $Listener
    hidden [System.Text.Encoding] $Utf8 = (New-Object System.Text.UTF8Encoding($false))

    RunSheetServer([int] $port, [MeetingStore] $store, [WebRoot] $web) {
        $this.Port     = $port
        $this.Prefix   = "http://localhost:$port/"
        $this.Store    = $store
        $this.Web      = $web
        $this.Listener = New-Object System.Net.HttpListener
        $this.Listener.Prefixes.Add($this.Prefix)
    }

    [void] Start() {
        $this.Listener.Start()
    }

    # Handles requests until Ctrl+C, then closes the listener.
    [void] Run() {
        try {
            while ($this.Listener.IsListening) {
                # Wait in short slices so Ctrl+C can stop the script between them.
                $task = $this.Listener.GetContextAsync()
                while (-not $task.AsyncWaitHandle.WaitOne(250)) { }
                $this.Handle($task.GetAwaiter().GetResult())
            }
        } finally {
            $this.Listener.Stop()
            $this.Listener.Close()
        }
    }

    # ---- Routing ----

    hidden [void] Handle([System.Net.HttpListenerContext] $ctx) {
        try {
            $this.Route($ctx)
        } catch {
            Write-Warning "$($ctx.Request.HttpMethod) $($ctx.Request.Url.AbsolutePath): $($_.Exception.Message)"
            # The details (which can include file paths) stay in this window, not in the response.
            $status  = 500
            $message = 'Something went wrong. The PowerShell window has the details.'
            if ($_.Exception -is [RequestTooLarge]) { $status = 413; $message = $_.Exception.Message }
            try { $this.SendJson($ctx, @{ error = $message }, $status) } catch { }
        }
    }

    hidden [void] Route([System.Net.HttpListenerContext] $ctx) {
        $req  = $ctx.Request
        $path = $req.Url.AbsolutePath

        # Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
        if ($req.Headers['Host'] -notmatch "^(localhost|127\.0\.0\.1)(:$($this.Port))?$") {
            $this.SendText($ctx, 403, 'Forbidden'); return
        }

        if ($path -like '/api/*') {
            $this.RouteApi($ctx, $path.TrimEnd('/')); return
        }

        if ($req.HttpMethod -eq 'GET') {
            $file = $this.Web.Find($path)
            if ($file) { $this.Send($ctx, 200, $file.Bytes, $file.ContentType); return }
        }
        $this.SendText($ctx, 404, 'Not found')
    }

    hidden [void] RouteApi([System.Net.HttpListenerContext] $ctx, [string] $path) {
        $req    = $ctx.Request
        $method = $req.HttpMethod

        # Writes must carry a custom header. Other websites can't add it without a CORS
        # preflight, which this server never approves, so they can't change your data.
        if ($method -ne 'GET' -and $req.Headers['X-Run-Sheet'] -ne '1') {
            $this.SendJson($ctx, @{ error = 'Missing X-Run-Sheet header' }, 403); return
        }

        if ($path -eq '/api/meetings') {
            switch ($method) {
                'GET'  { $this.SendJson($ctx, @($this.Store.List($req.QueryString['q'])), 200); return }
                'POST' { $this.SendJson($ctx, $this.Store.Create($this.ReadBody($req)), 201); return }
            }
        }

        if ($path -eq '/api/backup') {
            switch ($method) {
                'GET' {
                    $name = 'meetings-backup-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.zip'
                    $this.SendDownload($ctx, $this.Store.BackupZip(), 'application/zip', $name); return
                }
                'POST' {
                    $result = $this.Store.RestoreZip($this.ReadBytes($req, [RunSheetServer]::MaxBackup))
                    if ($null -eq $result) { $this.SendJson($ctx, @{ error = "That file isn't a backup zip" }, 400); return }
                    $this.SendJson($ctx, $result, 200); return
                }
            }
        }

        if ($path -eq '/api/settings') {
            switch ($method) {
                'GET' { $this.SendRaw($ctx, 200, $this.Store.ReadSettings()); return }
                'PUT' { $this.SendRaw($ctx, 200, $this.Store.WriteSettings($this.ReadBody($req))); return }
            }
        }

        $m = [regex]::Match($path, '^/api/meetings/([^/]+)$')
        if ($m.Success -and [MeetingStore]::IsValidId($m.Groups[1].Value)) {
            $id = $m.Groups[1].Value
            if (-not $this.Store.Exists($id)) {
                $this.SendJson($ctx, @{ error = 'Meeting not found' }, 404); return
            }
            switch ($method) {
                'GET'    { $this.SendRaw($ctx, 200, $this.Store.ReadRaw($id)); return }
                'PUT'    {
                    $saved = $this.Store.Update($this.ReadBody($req), $id)
                    if ($null -eq $saved) {
                        $this.SendJson($ctx, @{ error = 'This meeting was saved somewhere else after you opened it' }, 409); return
                    }
                    $this.SendJson($ctx, $saved, 200); return
                }
                'DELETE' { $this.Store.Remove($id); $this.SendJson($ctx, @{ deleted = $id }, 200); return }
            }
        }

        $this.SendJson($ctx, @{ error = 'Not found' }, 404)
    }

    # ---- Request / response helpers ----

    hidden [string] ReadBody([System.Net.HttpListenerRequest] $request) {
        $bytes  = $this.ReadBytes($request, [RunSheetServer]::MaxBody)
        $reader = New-Object System.IO.StreamReader((New-Object System.IO.MemoryStream(, $bytes)), $this.Utf8)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    }

    # The request body, or a RequestTooLarge error once it passes $max bytes. Counts what is
    # actually read, because a chunked upload has no Content-Length to check.
    hidden [byte[]] ReadBytes([System.Net.HttpListenerRequest] $request, [long] $max) {
        $tooLarge = "That is too large (the limit is $([int]($max / 1MB)) MB)"
        if ($request.ContentLength64 -gt $max) { throw [RequestTooLarge]::new($tooLarge) }
        $buffer = New-Object System.IO.MemoryStream
        $chunk  = New-Object byte[] 65536
        $n = 0
        while (($n = $request.InputStream.Read($chunk, 0, $chunk.Length)) -gt 0) {
            if ($buffer.Length + $n -gt $max) { throw [RequestTooLarge]::new($tooLarge) }
            $buffer.Write($chunk, 0, $n)
        }
        return $buffer.ToArray()
    }

    # A file the browser saves instead of showing.
    hidden [void] SendDownload([System.Net.HttpListenerContext] $ctx, [byte[]] $bytes, [string] $contentType, [string] $fileName) {
        $ctx.Response.Headers['Content-Disposition'] = "attachment; filename=`"$fileName`""
        $this.Send($ctx, 200, $bytes, $contentType)
    }

    hidden [void] Send([System.Net.HttpListenerContext] $ctx, [int] $status, [byte[]] $bytes, [string] $contentType) {
        $res = $ctx.Response
        $res.StatusCode  = $status
        $res.ContentType = $contentType
        $res.Headers['Cache-Control'] = 'no-store'   # always serve the latest page files and data
        # Other websites can't put the page in a frame (clickjacking), and the page only loads its own files.
        $res.Headers['X-Frame-Options'] = 'DENY'
        $res.Headers['X-Content-Type-Options'] = 'nosniff'
        $res.Headers['Content-Security-Policy'] = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.OutputStream.Close()
    }

    hidden [void] SendText([System.Net.HttpListenerContext] $ctx, [int] $status, [string] $text) {
        $this.Send($ctx, $status, $this.Utf8.GetBytes($text), 'text/plain; charset=utf-8')
    }

    # Sends a string that is already JSON (e.g. a meeting file as stored).
    hidden [void] SendRaw([System.Net.HttpListenerContext] $ctx, [int] $status, [string] $json) {
        $this.Send($ctx, $status, $this.Utf8.GetBytes($json), 'application/json; charset=utf-8')
    }

    hidden [void] SendJson([System.Net.HttpListenerContext] $ctx, [object] $object, [int] $status) {
        $this.SendRaw($ctx, $status, (ConvertTo-Json -InputObject $object -Depth 10 -Compress))
    }
}
