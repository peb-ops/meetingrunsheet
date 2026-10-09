# Meeting Run Sheet

An offline meeting facilitation tool for producers. A small PowerShell script serves a run sheet
in your browser on `localhost`: plan the meeting, run it against the clock, and record decisions
and action points. Every meeting is saved as a JSON file on your own machine.

It facilitates the meeting and stops there: due dates and chasing actions belong in your tracker.

No installs, no admin rights, no internet connection, no external services.

## Requirements

- Windows with Windows PowerShell 5.1 (built in)
- Any modern browser (Edge, Chrome, Firefox)

## Run it

Double-click `Start-RunSheet.cmd`, or from a terminal:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\MeetingRunSheet.ps1
```

The page opens at <http://localhost:8080>. Stop the server with Ctrl+C in its window.

| Option | Default | |
|---|---|---|
| `-Port` | `8080` | Port to listen on (localhost only) |
| `-DataDir` | `meetings` next to the script | Folder for the meeting files |
| `-NoBrowser` | off | Don't open the browser on start |

```powershell
.\MeetingRunSheet.ps1 -Port 8090 -DataDir "D:\Notes\Meetings" -NoBrowser
```

## What it does

- **Brief:** title, goal ("we leave this meeting with..."), meeting type with tips, date, timebox,
  note-taker and attendees.
- **Agenda:** items with minutes, checked against the timebox. Press Enter to add the next item.
- **Meeting timer:** counts down each agenda item, turns amber near the end and red when over,
  shows the time left in the browser tab, and keeps running if the page is reloaded. Change the
  agenda while it runs and the timer stays on the item it was on.
- **Record:** under each agenda item, its decision (or a "left open" mark), notes and action
  points (what gets done and who owns it; an action with no owner is flagged and offers the
  attendees as one-click buttons), plus lists for decisions outside the agenda and the parking
  lot. Wrap up shows it all as one summary, with a short self-review.
- **Facilitation checklist:** before, during and after the meeting.
- **Library:** every saved meeting in a searchable sidebar and a calendar.
- **Follow-up meeting:** copies the brief, attendees and agenda into a new meeting, linked back
  to the original, and shows what was decided last time while you plan.
- **Repeat weekly** (the ... menu): plans a saved meeting again for the coming weeks. The brief of
  each one shows its place in the series, with links to the previous and next meeting.
- **Copy notes:** a plain-text summary ready to paste into chat or email, or the same notes as
  Markdown for a wiki, Confluence or GitHub. **Print or save as PDF** prints the summary.
- **Backup** (the ... menu): download every meeting as a zip, and restore from a backup zip (adds
  missing meetings, never overwrites one you have). A backup zip is also written on every start.
- **Deleted meetings and backups** (the ... menu): put a deleted meeting back, or restore the
  meetings that are missing from one of the startup backups.

While a meeting runs, a meeting that has been saved before is saved again automatically about 20
seconds after you change it. Unsaved work is also kept as a draft in the browser and offered back
if the page closes unexpectedly.
Light and dark themes follow your system setting; Theme in the ... menu picks one for this browser
(Light, Dark, Paper, Sky, Midnight or Forest).

## Your data

Meetings are stored as `meetings\<id>.json` (UTF-8). The folder is git-ignored and never leaves
your machine. Use **Download backup** from the ... menu to make a copy.

Inside that folder the app also keeps:

- `backups\` - a zip of every meeting, written each time the app starts (the newest 10 are kept)
- `deleted\` - meetings you deleted; **Deleted meetings and backups** in the ... menu puts one back
- `settings\page.json` - your theme and sidebar choice, so another browser starts the same way

If the same meeting is open in two tabs, the second save asks before it overwrites the first.

## Customising

The page files are in `web\` and are read from disk on every request, so edits only need a
browser refresh:

- `web\content.js` - checklist items and meeting-type tips
- `web\styles.css` - colours and layout (theme colours are at the top)

## Project layout

```
MeetingRunSheet.ps1      entry point: options, startup
Start-RunSheet.cmd       double-click launcher
lib\MeetingStore.psm1    meeting files on disk, backup/restore, settings
lib\RunSheetServer.psm1  HTTP listener and JSON API
lib\WebRoot.psm1         serves the page files
web\                     the page (HTML, CSS, plain JavaScript; no build step)
tests\Run-Tests.ps1      test suite
```

## Tests

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1
```

The tests start their own server on port 8199 with a temporary data folder, so your meetings are
never touched. If Microsoft Edge is installed they also check the page renders and use it the
way a person would (typing, Enter, clicks, save and reopen) from a temporary copy on port 8200.
