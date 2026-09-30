/*
  Run sheet content: checklist items and meeting-type tips.
  Edit freely, then refresh the browser. No server restart needed.

  Checklist items: [id, title, description]. Saved meetings store ticks as "<phase id>:<item id>"
  (e.g. "before:send-agenda"), so you can reorder, insert and remove items freely.
  Never RENAME an id or reuse an old one for a different item, and keep ids unique within a phase.
  Don't rename phase ids ("before", "during", "after") or TYPES keys either.

  What belongs here: actions the facilitator could forget. If the brief or record
  already has a field for something, the empty field is the reminder, so put the
  advice in that field's data-help tooltip in index.html instead of adding a checklist item.
*/

// Each item is [id, title, description].
const PHASES = [
  { id: "before", name: "Before", items: [
    ["send-agenda", "Send agenda and pre-reads", "At least 24h ahead: TDD, crash data, build number, burndown."],
    ["prep-room", "Prep the room / call", "Build running, dashboards open, screen share tested, tracker ready."],
  ]},
  { id: "during", name: "During", items: [
    ["start-on-time", "Start on time", "Don't reward late arrivals by recapping from the start."],
    ["state-goal", "State goal, timebox and decision owner", "\"We have 30 minutes and we leave with...\""],
    ["park-tangents", "Park tangents out loud", "Write them in the parking lot, name who follows up, move on."],
    ["quiet-voices", "Bring in quieter voices", "Ask QA, tech art and juniors directly. They often spot the risk."],
    ["stay-neutral", "Stay neutral while facilitating", "Say when you step out of the role to give your own view."],
    ["call-decision", "Paraphrase, then call the decision", "\"So what I'm hearing is...\", then the decision owner calls it, or \"disagree and commit\"."],
    ["read-back", "Read back decisions and actions", "Each action gets one owner and a due date, in the room."],
    ["end-on-time", "End on time or early", "Give the time back if you've met the goal."],
  ]},
  { id: "after", name: "After", items: [
    ["send-notes", "Send notes within a few hours", "Use Copy notes. Decisions, actions (owner + due), parking lot, open questions."],
    ["log-actions", "Log actions in the tracker", "Jira, Hansoft, Shotgrid or similar. Put the ticket keys in the Ticket column."],
  ]},
];

// Shown in the timer bar when you press Wrap up after the last agenda item.
const WRAP_UP = "Read back decisions and actions: each action gets one owner and a due date. Then end on time, or early.";

// Meeting types: key -> [display name, tip shown under the brief].
// The key is saved in meeting files. The dropdown lists types in this order; "general" is the default.
const TYPES = {
  general:   ["General / decision", "Start with the decision you need, then the context. If there's no decision, it may be an update that could go in writing."],
  kickoff:   ["Kickoff", "Leave with scope, owners, a definition of done and the known risks, all written down. Say out loud what's out of scope. Agree how and when progress gets reported."],
  planning:  ["Sprint planning", "Commit to capacity, not hope. Surface dependencies across art, design and engineering before committing. Leave buffer for bugs."],
  triage:    ["Bug triage", "Decide fast: severity, owner, target milestone. Aim for about 2 minutes per bug. If it needs investigation, assign that as the action."],
  playtest:  ["Playtest review", "Observations before opinions: what players did, then what they said, then what we think. Separate the problem from the fix. Leave with a ranked issue list, each with an owner."],
  design:    ["Tech design review", "Pre-read is mandatory. Review risks, alternatives and cost, not code style. Leave with approve, approve with changes, or rework."],
  milestone: ["Milestone review / go-no-go", "Go through criteria against evidence (builds, perf numbers, bug counts). Name the risks out loud. Record the go/no-go and its conditions."],
  retro:     ["Retrospective", "Make it safe: no blame, no leads dominating. Collect silently first, then group and vote. Leave with 1-3 concrete changes, each with an owner."],
};
