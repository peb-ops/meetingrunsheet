# Meeting Run Sheet

An offline meeting facilitation tool for producers. A small PowerShell script serves a run sheet
in your browser on `localhost`: plan the meeting, run it against the clock, record decisions and
actions, and follow up. Every meeting is saved as a JSON file on your own machine.

No installs, no admin rights, no internet connection, no external services.

## Requirements

- Windows with Windows PowerShell 5.1 (built in) or PowerShell 7
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
  shows the time left in the browser tab, and keeps running if the page is reloaded.
- **Record:** action items (owner, due date, ticket; missing owners/dates and overdue dates are
  flagged), decisions, parking lot, and a short self-review.
- **Facilitation checklist:** before, during and after the meeting.
- **Library:** every saved meeting in a searchable sidebar, with open and overdue action counts.
- **Follow-up meeting:** copies the brief and carries open actions into a new meeting, linked back
  to the original.
- **Copy notes:** a plain-text summary ready to paste into chat or email.
- **Backup and export** (the ... menu): download every meeting as a zip, restore from a backup
  zip (adds missing meetings, never overwrites one you have), and export all actions as CSV for
  Excel or a tracker import.

Unsaved work is kept as a draft in the browser and offered back if the page closes unexpectedly.
Light and dark themes follow your system setting.

## Your data

Meetings are stored as `meetings\<id>.json` (UTF-8). The folder is git-ignored and never leaves
your machine. Use **Download backup** from the ... menu to make a copy.

## Customising

The page files are in `web\` and are read from disk on every request, so edits only need a
browser refresh:

- `web\content.js` - checklist items and meeting-type tips
- `web\styles.css` - colours and layout (theme colours are at the top)

## Project layout

```
MeetingRunSheet.ps1      entry point: options, startup
Start-RunSheet.cmd       double-click launcher
lib\MeetingStore.psm1    meeting files on disk, follow-up sync, backup/restore, CSV
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
never touched. If Microsoft Edge is installed they also check the page renders.
