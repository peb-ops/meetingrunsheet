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

## 2026-09-25 (v1.2.0: facilitator improvements, git, tests)

- Git: `git init` on `main`, repo-local author peb5588 (GitHub noreply email), `.gitignore` (meetings/, test-data/, *.tmp, .claude/settings.local.json). One commit per item below; `git log --oneline` lists them.
- Stable checklist ids (`web/content.js`, `web/app.js`): items are `[id, title, description]`; ticks save as `before:needs-meeting`; old positional keys are translated via `LEGACY_CHECKS` (v1.0 order).
- Agenda check (`app.js`, `index.html`, `styles.css`): `parseAgenda()` reads "Item (N min)" lines; a line under the agenda shows the total vs the timebox and items missing minutes.
- Weak actions (`app.js`, `styles.css`, `lib/MeetingStore.psm1`): open actions missing an owner or due date get a dashed amber outline; overdue dates are red; the list API returns `overdueActions` and the sidebar shows "N overdue".
- Carried actions (`lib/MeetingStore.psm1`, `lib/RunSheetServer.psm1`, `app.js`, `index.html`, `styles.css`): action ids; follow-ups store `follows`; the store syncs `carried` on the original on every save and releases on delete (`Create/Update/Remove` replace direct `Save/Delete` in the router). Carried rows are read-only with a link to the follow-up; the follow-up links back.
- Meeting timer (new `web/timer.js`, `index.html`, `styles.css`): Start meeting button and sticky bar.
- Local draft (`app.js`): localStorage `runsheet-draft`, offered on load via the confirm bar (`ask()` got an `onNo` callback, `markClean()` added).
- Tests (new `tests/Run-Tests.ps1`): 45 checks, all passing on 5.1, including headless Edge render. Page behaviour was also checked with a temporary browser harness (18/18: agenda warning, flags, timer warn/over/next, draft store/restore, follow-up link, carried rows, badges, notes) plus screenshots at desktop and narrow widths; the harness wasn't kept.
- `CLAUDE.md`: files, test command, API, data format (`checks` ids, `actions[].id`, `carried`, `follows`), features, rule to run tests before committing, v1.2.0 history.
- Different from plan: tests are plain PowerShell, not Pester (Windows ships Pester 3.4; installing 5 breaks the no-installs rule). A literal middle dot slipped into `timer.js` and was replaced with `·`.
- Not tested: PowerShell 7 (not installed), real mouse hover/touch, and the Ctrl+C path after these changes (the server loop is unchanged).
- The real `meetings\` folder is still empty and was not touched.

## 2026-09-26 (v1.3.0: agenda list and Wrap up)

- `web/index.html`, `web/styles.css`, `web/app.js`: the agenda text box is now a row editor (number, item, minutes, up/down, remove, Add item; Enter adds the next row). `agendaItems()` feeds the agenda check and the timer; `fromSaved()` now upgrades every old format in one place (text agenda -> rows via `agendaFromText()`, positional ticks, missing action ids) for both opened meetings and restored drafts.
- Data: new top-level `agenda: [{t, m}]`; `fields.agenda` is no longer written. Follow-ups copy the agenda.
- `web/timer.js`: the last item's button reads "Wrap up" (was a disabled "Last item"); pressing it shows `WRAP_UP` (new in `web/content.js`) with the meeting's time left, red if over. With no agenda the bar counts down the timebox with only Stop. The label is one `#tLabel` ("Now 2/4", "Now", "Wrap up").
- `setupHelp()` accepts any `[data-help]` element, using `data-for` when it isn't a label (the agenda label is a span).
- `tests/Run-Tests.ps1`: +2 checks (a one-row agenda is saved as a list, not collapsed by 5.1's JSON cmdlets; the agenda editor renders). 47/47 pass on 5.1.
- A temporary browser harness passed 20/20 (legacy file and legacy draft convert to rows, Enter/move/remove, sum line, Next -> Wrap up -> reminder, over state, no-agenda bar, save/reopen/follow-up). Screenshots checked at 1280px and 500px. The harness wasn't kept.
- Not tested: PowerShell 7, real mouse/touch.

## 2026-10-02 (v1.5.0: attendee list, Decision owner removed)

- `web/index.html`: removed the Decision owner box; the Note-taker tooltip no longer says "Ideally not you."; Attendees is now a row list (`#attendeeRows`) with an Add person button, reusing the agenda table styles.
- `web/app.js`: `decider` and `attendees` dropped from `FIELDS`/`FOLLOW_UP_FIELDS`; new `renderAttendees()`/`addAttendee()` (Enter adds the next row, x removes one); saved as `attendees: [...]`; `fromSaved()` splits old `fields.attendees` text on `,` `;` and new lines; Follow-up copies the list; Copy notes prints "Attendees: a, b" and no longer prints Decision owner. Old `fields.decider` values stay in files, hidden.
- `tests/Run-Tests.ps1`: +2 checks (a one-name attendees list stays a list on 5.1; the attendee editor renders); tooltip count 8 -> 7. 50/50 pass on 5.1.
- `CLAUDE.md`: data format, page features, v1.5.0 history.
- Not tested: PowerShell 7, clicking through the attendee editor in a real browser.
