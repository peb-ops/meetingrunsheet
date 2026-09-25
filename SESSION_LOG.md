# Session Log

## 2026-09-25

- Found that the v1.0.1 fix listed in CLAUDE.md was missing: `MeetingRunSheet.ps1` still defaulted `-DataDir` via `Join-Path $PSScriptRoot` inside `param()`.
- Reproduced on Windows PowerShell 5.1: "Join-Path : Cannot bind argument to parameter 'Path' because it is an empty string" (line 31).
- `MeetingRunSheet.ps1`: `-DataDir` now defaults to `''`; the script body fills it from `$PSScriptRoot`, falling back to `Split-Path -Parent $MyInvocation.MyCommand.Path`.
- Tested on 5.1 (from scratchpad copies, ports 8091/8092): default DataDir and relative `-DataDir`. All API routes, search, CSRF 403 and 404s pass (15/15), and the server wrote nothing to stderr.
- Not tested on PowerShell 7: `pwsh` isn't installed on this machine.
- The script is still pure ASCII, with a single `'@` line. No `meetings\` folder was created in the project.

## 2026-09-25 (v1.1.0: modular split)

- `web/` (new): the page moved out of the `$Html` here-string into `index.html`, `styles.css`, `content.js` (PHASES/TYPES data, with an "append only" warning) and `app.js` (reformatted to readable multi-line code, same behaviour). Inline `style=` attributes became CSS classes (`.side-head`, `.panel-title`, `.label-above`, `.add-action`).
- `lib/MeetingStore.psm1` (new): class `MeetingStore`, the former storage functions.
- `lib/WebRoot.psm1` (new): class `WebRoot`, serves `web/` files read on every request, with an extension whitelist and a path-traversal guard.
- `lib/RunSheetServer.psm1` (new): class `RunSheetServer`, the former routing, HTTP helpers and server loop.
- `MeetingRunSheet.ps1`: now only params, path resolution and wiring. Loads the classes with `using module`.
- `CLAUDE.md`: new file layout, class/`using module` rules, v1.1.0 in History; dropped the obsolete `'@` rule and the "split into index.html" idea.
- Tested on 5.1 (scratchpad copy, ports 8093-8095): 26/30 HTTP checks passed as written. The 4 "failures" were traversal and foreign-Host requests that HTTP.sys itself rejects (403/400) before they reach the script, same as v1.0.x. `WebRoot.Find` was tested directly against 7 escape attempts and returned null for all. Also checked: live CSS edit served without restart, a real Ctrl+C stops the server with "Server stopped.", default and relative `-DataDir`, launch from another working directory, `node --check` on both JS files.
- Not tested: PowerShell 7 (not installed), and clicking through the page in a browser.
- The real `meetings\` folder in the project (created 15:46, empty) was not touched.
- Differences from the plan: none, apart from the label spacing now being 6px everywhere (the copy-fallback label was 8px).

## 2026-09-25 (v1.1.1: content review)

- `web/content.js`: checklist went from 8/10/6 to 5/9/5 items.
  - Before: removed goal, decision owner, timebox and note-taker items (each duplicated a brief field); added "Pre-wire contentious decisions".
  - During: merged "Paraphrase to confirm" into "Paraphrase, then call the decision".
  - After: removed "Self-review" (duplicated the self-review field); descriptions now point to Copy notes and the Ticket column.
  - Types: removed standup; added kickoff and playtest; reordered roughly by production lifecycle. Header comment now states the content rule.
- `web/index.html`: advice from the removed items moved into the Goal, Decision owner, Note-taker, Agenda and Self-review placeholders; removed the "Technical Producer - Facilitation" header label.
- `CLAUDE.md`: type list, a note that the reshuffle was only safe because no meetings were saved, unknown-type fallback, v1.1.1 history entry.
- Checked: the real `meetings\` folder was empty (0 files) before the positional reshuffle; `node --check` passes; counts 5/9/5 with 8 types; web files ASCII; a 5.1 scratch server (port 8096) serves the new page.
- Not tested: clicking through the page in a browser.

## 2026-09-25 (v1.1.2: readable help text)

- `web/index.html`: advice moved out of placeholders into `data-help` on 7 labels (Goal, Decision owner, Note-taker, Agenda, Decisions, Parking lot, Self-review). Placeholders are now short examples. Agenda label is just "Agenda"; example lines read "Item (N min)" and add up to the 30-min timebox example. The Self-review label was shortened; its questions moved to the tooltip.
- `web/app.js`: `setupHelp()` / `closeHelp()` build a (?) button and tooltip from each `data-help` label. Hover shows it, click or tap pins it, Esc or clicking outside closes it. Inputs get `aria-describedby`. The (?) buttons have `tabIndex=-1` so Tab still goes field to field.
- `web/styles.css`: `.label-row`, `.help`, `.help-tip` (capped at the field's width so it can't run off-screen). Also fixed a pre-existing bug: below ~640px the action table's 600px min-width pushed the Record section wider than the window; `.record .full{min-width:0}` lets the table scroll instead.
- `web/content.js`, `CLAUDE.md`: comments and docs point to `data-help`; v1.1.2 history entry.
- Checked in headless Edge against test servers (ports 8097/8098, data in %TEMP%): 7 help rows, 7 described inputs, 19 checklist items, 8 types; screenshots at 1280px and narrow with a tooltip pinned; no horizontal overflow at 420/700/1280 after the fix. `node --check` passes; web files ASCII. Real `meetings\` still empty and untouched.
- Not tested: real mouse hover and touch; the tooltip only rendered in the pinned (clicked) state.
