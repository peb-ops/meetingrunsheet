# Meeting Run Sheet

Offline meeting facilitation tool for a technical producer at a game studio. A PowerShell
script serves a checklist web page on localhost and stores each meeting as a JSON file.

## Files

- `MeetingRunSheet.ps1` - entry point only: params, path resolution, wires the classes together, startup banner.
- `lib\MeetingStore.psm1` - class `MeetingStore`: list/read/save/delete meeting JSON files, id validation.
- `lib\WebRoot.psm1` - class `WebRoot`: serves files from `web\` (extension whitelist, path-traversal guard).
- `lib\RunSheetServer.psm1` - class `RunSheetServer`: `HttpListener`, Host/CSRF guards, routing, API, Ctrl+C-friendly loop.
- `web\index.html` (markup), `web\styles.css` (theme + layout), `web\content.js` (`PHASES` checklist and
  `TYPES` tips, data only), `web\app.js` (page behaviour). Read from disk on every request with
  `Cache-Control: no-store`, so UI edits need only a browser refresh, not a server restart.
- `Start-RunSheet.cmd` - double-click launcher; runs the script with `-ExecutionPolicy Bypass` and passes arguments through.
- `meetings\*.json` - user data, created on first run. Never delete or rewrite these while developing.

## Run

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\MeetingRunSheet.ps1            # Windows PowerShell 5.1
pwsh -NoProfile -File .\MeetingRunSheet.ps1 -Port 8090 -DataDir .\test-data -NoBrowser  # PowerShell 7, test data
```

Params: `-Port` (8080), `-DataDir` (default `meetings` next to the script, resolved in the script body), `-NoBrowser`.
Stop with Ctrl+C (the loop waits on `GetContextAsync()` in 250 ms slices so Ctrl+C works).

When testing, always use a separate `-DataDir` and a non-default port so the user's real meetings are untouched.

## API

All JSON. Non-GET requests must send header `X-Run-Sheet: 1` (CSRF guard). Host header must be localhost/127.0.0.1.

| Method | Path | Notes |
|---|---|---|
| GET | `/`, `/<file>` | page files from `web\` (`/` = `index.html`); only .html .css .js .json .svg .png .ico |
| GET | `/api/meetings?q=` | summaries `{id,title,date,type,savedAt,openActions}`, newest first; `q` = case-insensitive substring of raw file text |
| POST | `/api/meetings` | create, returns meeting with new `id` (201) |
| GET/PUT/DELETE | `/api/meetings/{id}` | id must match `^[A-Za-z0-9-]{1,64}$` |

## Data format

```json
{
  "fields": { "title": "", "type": "triage", "date": "2026-09-25", "length": "30", "goal": "",
              "decider": "", "notetaker": "", "attendees": "", "agenda": "",
              "decisions": "", "parking": "", "reflect": "" },
  "checks": { "before-0": true },
  "actions": [ { "a": "action", "o": "owner", "d": "2026-10-02", "t": "GAME-123", "done": false } ],
  "id": "20260925-150845-216bb6",
  "savedAt": "2026-09-25T15:08:45"
}
```

- `fields.type`: general, kickoff, planning, triage, playtest, design, milestone, retro (keys of `TYPES` in `web\content.js`).
- `checks` keys are `<phase>-<index>` into `PHASES` in `web\content.js`, so they are positional:
  append new checklist items at the end of a phase, never insert in the middle.
  (The v1.1.1 reshuffle was only safe because no meetings had been saved yet.)
- The page tolerates unknown `type` values (e.g. old `standup`) by falling back to General.
- `id` and `savedAt` are set by the server. Files are written temp-then-move, UTF-8 without BOM.

## Page features

Sidebar list with search and open-action badges; brief (with per-type tips); Before/During/After
checklists with progress; decisions, parking lot, action table with Done checkbox; self-review.
Buttons: New, Save (Ctrl+S), Copy notes (plain-text summary), Follow-up meeting (copies brief,
today's date, carries over open actions), Delete (inline confirm, no browser dialogs).
Field advice lives in `data-help` on the label and shows as a (?) tooltip (hover, or click/tap to pin; Esc closes);
placeholders hold only short examples, because they get cut off and vanish once you type.
Warns on unsaved changes. Light and dark themes via `prefers-color-scheme`. No external resources (works offline).

## Hard rules

- **Must work on Windows PowerShell 5.1 and PowerShell 7.** Test on 5.1 (`powershell.exe`), not just `pwsh`.
  Known 5.1 trap already hit: `$PSScriptRoot` can be empty inside `param()` defaults - resolve paths in the body.
- **Keep .ps1/.psm1 files pure ASCII** (5.1 reads BOM-less files as ANSI). Web files are served as UTF-8 bytes,
  but keep them ASCII too: HTML entities (`&middot;`) and JS escapes (`\u00b7`).
- **Classes load with `using module`, not dot-sourcing.** 5.1 resolves class types at parse time, so a dot-sourced
  class can't be named in the calling script. `using module` paths are relative to the file that contains them,
  and `using` lines must come before `param()`. Class methods can't see script variables: pass values in.
  Inside class methods prefer .NET file APIs over cmdlets; methods only output what they `return`.
- No dependencies, installs, or admin rights. Bind to localhost only.
- Methods/functions returning arrays: wrap calls in `@()` before `ConvertTo-Json -InputObject` so 0/1 items stay arrays.
- Preserve compatibility with existing meeting JSON files.

## History

- v1.0.0 - initial version.
- v1.0.1 - fixed "Join-Path: Cannot bind argument to parameter 'Path'" on Windows PowerShell 5.1 (DataDir default moved out of `param()`).
- v1.1.0 - split into classes (`lib\*.psm1`) and page files (`web\*`); API and data format unchanged.
- v1.1.1 - checklist trimmed to 5/9/5 items: removed items that duplicate a form field (advice moved to placeholders),
  merged paraphrase + call the decision, added "Pre-wire contentious decisions". Types: removed standup, added
  kickoff and playtest. Removed the header label. Content rule: checklist items are only for actions the
  facilitator could forget; if a field exists for it, put the advice on that field (now its `data-help` tooltip).
- v1.1.2 - field advice moved from placeholders to (?) tooltips (`data-help` + `setupHelp()`); agenda example now
  "Item (N min)"; fixed the Record section overflowing the window below ~640px (action table min-width).

## Ideas not yet built

Cross-meeting "open actions" view in the page, CSV export, Jira/ticket links, due-date reminders,
and a Pester test suite.
