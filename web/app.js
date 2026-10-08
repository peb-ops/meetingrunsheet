/*
  Meeting Run Sheet page behaviour.
  Checklist items and meeting-type tips live in content.js (PHASES, TYPES).
*/

// Brief/record fields saved under meeting.fields. Each has an element with id "f-<name>" in index.html.
// The agenda and attendees are separate lists: meeting.agenda and meeting.attendees (see below).
// Old files may still have fields.decider (box removed in v1.5.0); it is kept but not shown.
const FIELDS = ["title", "type", "date", "time", "length", "goal", "notetaker", "reflect", "goalmet"];
// Fields copied into a follow-up meeting (the agenda and attendees are copied too).
const FOLLOW_UP_FIELDS = ["title", "type", "length", "goal", "notetaker"];

const $ = s => document.querySelector(s);
const typeSel = $("#f-type");

/* ---- State ---- */

// A local date as "yyyy-MM-dd".
function isoDay(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
const today = () => isoDay(new Date());
// Action ids stay the same when an action is carried into a follow-up meeting.
const newActionId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const blankAction = () => ({ id: newActionId(), a: "", o: "", d: "", t: "", done: false });
const blankAgendaRow = () => ({ id: newActionId(), t: "", m: null });
const blank = () => ({ id: null, follows: null, fields: { type: "general", date: today() }, checks: {},
                       agenda: [blankAgendaRow()], attendees: [""], actions: [blankAction()] });
const typeName = key => (TYPES[key] || TYPES.general)[0];

let state = blank();
let dirty = false;
let pending = null;     // callback for "yes" on the inline confirm bar
let pendingNo = null;   // optional callback for "no"
let listTimer = null;
const knownMeetings = {};   // id -> summary from the last list load, for "Follow-up of ..." links

/* ---- Server API ---- */

async function api(method, url, body) {
  const opt = { method, headers: { "X-Run-Sheet": "1" } };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
  return data;
}

/* ---- Status, toast, confirm ---- */

function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.hidden = true, 2400);
}

function setStatus() {
  const s = $("#status");
  s.classList.toggle("dirty", dirty);
  s.textContent = dirty ? "Unsaved changes"
    : state.id ? "Saved " + (state.savedAt || "").replace("T", " ").slice(0, 16)
    : "New meeting";
  $("#deleteBtn").hidden = !state.id;
}

function markDirty() {
  dirty = true;
  setStatus();
  showStrips();
  if (phase === "wrap") showSummary();
  storeDraft();
}

// Call after the page matches what's saved (or the user chose to throw changes away).
function markClean() {
  dirty = false;
  clearDraft();
}

/* ---- Phases: Plan / Run / Wrap up ---- */

// The sheet shows one phase at a time. Cards say which phases they belong to with data-in
// (index.html) and styles.css hides the rest. Not saved: a meeting opens on Plan, or on Wrap up
// once its date has passed (renderAll), and the timer moves it to Run and Wrap up (timer.js).
let phase = "plan";

function setPhase(next) {
  phase = next;
  $("#sheet").dataset.phase = next;
  document.querySelectorAll("#phaseTabs button").forEach(b => {
    if (b.dataset.phase === next) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
  $('[data-for="agendaRows"]').textContent = next === "run" ? "Agenda and action items" : "Agenda";
  // Run edits the actions and the parking lot that the Wrap up summary shows, so redraw on a switch.
  showItemActions();
  showStrips();
  showSummary();
}

// The strip at the top of Plan (is the meeting ready?) and of Wrap up (what came out of it).
function showStrips() {
  const item = (id, ok, label, text) => {
    const el = $(id);
    const b = document.createElement("b");
    b.textContent = label;
    el.classList.toggle("ok", ok);
    el.replaceChildren(b, " " + text);
  };
  const f = state.fields;
  const goal = (f.goal || "").trim();
  item("#rGoal", !!goal, "Goal", goal ? "set" : "missing");

  const items = agendaItems();
  const total = items.reduce((sum, it) => sum + (it.min || 0), 0);
  const missing = items.some(it => it.min === null);
  const timebox = +f.length || 0;
  const over = timebox > 0 && total > timebox;
  item("#rAgenda", items.length > 0 && !over && !missing, "Agenda",
    !items.length ? "empty" : missing ? "has items without minutes" : over ? `is ${total} min, timebox ${timebox}`
      : timebox ? `${total} of ${timebox} min` : `${total} min, no timebox`);

  const before = PHASES.find(p => p.id === "before");
  const done = before.items.filter(([itemId]) => state.checks[checkKey(before, itemId)]).length;
  item("#rPrep", done === before.items.length, "Prep", `${done} of ${before.items.length} done`);

  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const decisions = state.agenda.filter(r => r.d && r.d.trim()).length
    + (f.decisions || "").split("\n").filter(x => x.trim()).length;
  const acts = state.actions.filter(a => a.a && a.a.trim());
  const weak = acts.filter(a => !a.done && !a.carried && !(a.o && a.o.trim() && a.d)).length;
  $("#oGoal").textContent = goal || "No goal was set";
  $("#oDecisions").textContent = count(decisions, "decision");
  $("#oActions").textContent = count(acts.length, "action");
  $("#oWeak").hidden = !weak;
  $("#oWeak").textContent = `${count(weak, "action")} need${weak === 1 ? "s" : ""} an owner or a date`;
}

function ask(message, yesLabel, fn, onNo) {
  $("#confirmMsg").textContent = message;
  $("#confirmYes").textContent = yesLabel;
  pending = fn;
  pendingNo = onNo || null;
  $("#confirmBox").hidden = false;
  $("#confirmYes").focus();
}

// Run fn now, or after the user agrees to discard unsaved changes.
function guard(fn) {
  if (dirty) ask("You have unsaved changes. Discard them?", "Discard", fn);
  else fn();
}

/* ---- Render: brief ---- */

function fillTypeOptions() {
  Object.entries(TYPES).forEach(([key, [name]]) => {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = name;
    typeSel.appendChild(o);
  });
}

function showTip() {
  const [name, tipText] = TYPES[typeSel.value] || TYPES.general;
  const tip = $("#typeTip");
  const b = document.createElement("b");
  b.textContent = name;
  tip.innerHTML = "";
  tip.append(b, document.createTextNode(tipText));
}

/* ---- Agenda: rows of { id, t: title, m: minutes, d: decision, n: notes } ----
   An action belongs to an agenda item when its g is that item's id (see showItemActions). */

// A row counts once it has a title, minutes, or something recorded on it.
const agendaFilled = r => !!((r.t && r.t.trim()) || r.m || (r.d && r.d.trim()) || (r.n && r.n.trim()));

// Filled-in rows as [{ title, min }] (min is null when not set). Used by the agenda check and the timer.
function agendaItems() {
  return (state.agenda || [])
    .filter(agendaFilled)
    .map(r => ({ title: (r.t || "").trim() || "Untitled item", min: +r.m > 0 ? +r.m : null }));
}

// Rows to save: drops empty ones. d and n are only written when there is something in them.
const agendaToSave = () => (state.agenda || []).filter(agendaFilled).map(r => {
  const row = { id: r.id, t: (r.t || "").trim() || "Untitled item", m: +r.m > 0 ? +r.m : null };
  if (r.d && r.d.trim()) row.d = r.d.trim();
  if (r.n && r.n.trim()) row.n = r.n.trim();
  return row;
});

// Converts the free-text agenda saved before v1.3.0 ("Item (15 min)" per line) into rows.
// Accepts "(15 min)", "15 min", "15m" or "15 minutes" at the end of a line, and drops "1." numbering.
function agendaFromText(text) {
  return String(text || "").split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const m = /\(?\s*(\d+)\s*(?:m|min|mins|minutes)\s*\)?\s*$/i.exec(line);
    const title = (m ? line.slice(0, m.index) : line).replace(/^\d+[.)]\s*/, "").replace(/[\s-]+$/, "");
    return { t: title || line, m: m ? +m[1] : null };
  });
}

/* ---- Attendees: a list of names ---- */

const attendeesToSave = () => (state.attendees || []).map(n => n.trim()).filter(Boolean);

// Before v1.5.0 attendees were one text field ("Eng lead, QA lead, design").
const attendeesFromText = text => String(text || "").split(/[,;\n]/).map(n => n.trim()).filter(Boolean);

/* ---- Row editors: the agenda and attendee tables ----
   One row per entry. Enter in a row adds the next one, x removes a row (the last row is
   emptied instead), and with movable: true each row gets up/down arrows.
     list()           the array being edited (looked up each time, because state gets replaced)
     blank()          a new empty entry
     cells(row, i)    HTML for the row's own cells (the arrows and x are added here)
     bind(tr, row, i) fills the row's inputs and wires them up; returns the inputs
     changed()        called after any edit
     rendered()       optional: called after the rows have been rebuilt                 */
function rowEditor({ tbody, list, blank, cells, bind, changed, rendered, movable = false, removeLabel }) {
  const ed = {};

  ed.render = () => {
    const rows = list();
    tbody.innerHTML = "";
    rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = cells(row, i)
        + (movable ? `<td class="mv"><button data-mv="-1" aria-label="Move up">&uarr;</button><button data-mv="1" aria-label="Move down">&darr;</button></td>` : "")
        + `<td class="x"><button aria-label="${removeLabel}">&times;</button></td>`;
      // Enter adds the next row, so a whole list can be typed without the mouse.
      bind(tr, row, i).forEach(input => input.onkeydown = e => {
        if (e.key === "Enter") { e.preventDefault(); ed.add(i + 1); }
      });
      tr.querySelectorAll("[data-mv]").forEach(b => {
        const to = i + +b.dataset.mv;
        b.disabled = to < 0 || to >= rows.length;
        b.onclick = () => ed.move(i, to);
      });
      tr.querySelector("td.x button").onclick = () => {
        rows.splice(i, 1);
        if (!rows.length) rows.push(blank());
        changed();
        ed.render();
      };
      tbody.appendChild(tr);
    });
    if (rendered) rendered();
  };

  ed.add = at => {
    list().splice(at, 0, blank());
    changed();
    ed.render();
    tbody.rows[at].querySelector("input,textarea").focus();
  };

  ed.move = (from, to) => {
    const rows = list();
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    changed();
    ed.render();
    // Keep focus on the same arrow so the row can be moved several places with the keyboard.
    const arrow = tbody.rows[to].querySelector(`[data-mv="${to > from ? 1 : -1}"]`);
    (arrow.disabled ? tbody.rows[to].querySelector("input,textarea") : arrow).focus();
  };

  return ed;
}

const agendaChanged = () => { markDirty(); showAgendaSum(); showAgendaTimes(); };

// A text box that wraps and grows with its text: the textarea sits on top of a hidden copy of the
// text (the span after it), and the copy is what gives it its height (.grow in styles.css).
// oneLine: the text is a single line that wraps, so pasted line breaks become spaces.
function growBox(box, value, oneLine, changed) {
  const copy = box.nextElementSibling;
  box.value = value || "";
  copy.textContent = box.value + " ";
  box.oninput = () => {
    if (oneLine && /[\r\n]/.test(box.value)) box.value = box.value.replace(/\s*[\r\n]+\s*/g, " ");
    copy.textContent = box.value + " ";
    changed(box.value);
  };
}

// Agenda rows whose record (decision + notes) is open. Not saved: every meeting opens collapsed.
const openRecs = new WeakSet();

// Each row is the item (start time, number, title, minutes) with its record underneath: what was
// decided and the notes of the discussion, so they stay with the item they belong to.
const agendaEditor = rowEditor({
  tbody: $("#agendaRows"),
  list: () => state.agenda,
  blank: blankAgendaRow,
  movable: true,
  removeLabel: "Remove item",
  changed: agendaChanged,
  rendered: () => { showAgendaTimes(); showItemActions(); },
  cells: (row, i) => `<td class="at"></td><td class="n">${i + 1}</td>
    <td class="t"><div class="t-line"><div class="grow"><textarea id="ag-t-${i}" rows="1" aria-label="Agenda item ${i + 1}" placeholder="${i ? "Next item" : "e.g. Context and goal"}"></textarea><span aria-hidden="true"></span></div><button class="rec-toggle" aria-controls="ag-rec-${i}" title="Decision, notes and actions for this item">Notes</button></div>
      <button class="rec-sum" title="Open the decision, notes and actions" hidden></button>
      <div class="rec" id="ag-rec-${i}" hidden>
        <label class="label" for="ag-d-${i}">Decision</label>
        <div class="grow"><textarea id="ag-d-${i}" rows="1" placeholder="What was decided, in one line"></textarea><span aria-hidden="true"></span></div>
        <label class="label" for="ag-n-${i}">Notes</label>
        <div class="grow"><textarea id="ag-n-${i}" rows="2" placeholder="Key points of the discussion"></textarea><span aria-hidden="true"></span></div>
        <span class="label">Actions</span>
        <div class="rec-acts"></div>
      </div></td>
    <td class="min"><input type="number" id="ag-m-${i}" min="1" step="1" aria-label="Minutes for item ${i + 1}" placeholder="min"></td>`,
  bind: (tr, row, i) => {
    const title = tr.querySelector(`#ag-t-${i}`);
    const min = tr.querySelector(`#ag-m-${i}`);
    const decision = tr.querySelector(`#ag-d-${i}`);
    const itemNotes = tr.querySelector(`#ag-n-${i}`);
    growBox(title, row.t, true, v => { row.t = v; agendaChanged(); });
    growBox(decision, row.d, true, v => { row.d = v; agendaChanged(); });
    growBox(itemNotes, row.n, false, v => { row.n = v; agendaChanged(); });
    decision.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); itemNotes.focus(); } };
    min.value = row.m ?? "";
    min.oninput = () => { row.m = min.value === "" ? null : +min.value; agendaChanged(); };
    tr.querySelector(".rec-toggle").onclick = () => {
      setRecord(row, !openRecs.has(row));
      if (openRecs.has(row)) decision.focus();
    };
    tr.querySelector(".rec-sum").onclick = () => editRecord(row);
    showRecord(tr, row);
    return [title, min];
  },
});

// Draws a row's record open or closed. Closed, a row with something recorded shows it as one line
// under the title: the decision in full (or the start of the notes), and how many actions it has.
function showRecord(tr, row) {
  const open = openRecs.has(row);
  const decision = (row.d || "").trim();
  const itemNotes = (row.n || "").trim().replace(/\s+/g, " ");
  const acts = state.actions.filter(a => a.g === row.id && a.a && a.a.trim()).length;
  const sum = tr.querySelector(".rec-sum");
  tr.querySelector(".rec").hidden = !open;
  tr.querySelector(".rec-toggle").setAttribute("aria-expanded", open);
  sum.hidden = open || !(decision || itemNotes || acts);
  sum.classList.toggle("decided", !!decision);
  sum.textContent = [
    decision ? "Decision: " + decision + (itemNotes ? " (+ notes)" : "") : itemNotes ? "Notes: " + itemNotes : "",
    acts ? `${acts} action${acts > 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(" \u00b7 ");
}

/* ---- Actions on agenda items ----
   In Run the agenda box is also where actions are written: each item's record lists the actions
   that came out of it (action.g = the item's id). Actions with no item (carried over from another
   meeting, from files saved before v1.17.0, or whose item was removed) can't be edited here; they
   show in the Wrap up summary. */

// One action as a line: what, owner, due, remove.
function actionLine(act) {
  const line = document.createElement("div");
  line.className = "act-line";
  line.innerHTML = `<div class="grow"><textarea rows="1" aria-label="Action" placeholder="What gets done"></textarea><span aria-hidden="true"></span></div>
    <input type="text" list="ownerList" aria-label="Owner" placeholder="Owner">
    <input type="date" aria-label="Due">
    <button class="x" aria-label="Remove action">&times;</button>`;
  const text = line.querySelector("textarea");
  const [owner, due] = line.querySelectorAll("input");
  const flag = () => {
    const open = !!(act.a && act.a.trim()) && !act.done && !act.carried;
    owner.classList.toggle("missing", open && !(act.o && act.o.trim()));
    due.classList.toggle("missing", open && !act.d);
    due.classList.toggle("overdue", isOverdue(act));
  };
  growBox(text, act.a, true, v => { act.a = v; flag(); markDirty(); });
  owner.value = act.o || "";
  owner.oninput = () => { act.o = owner.value; flag(); markDirty(); };
  owner.onchange = fillOwnerList;
  due.value = act.d || "";
  due.oninput = () => { act.d = due.value; flag(); markDirty(); };
  line.querySelector("button").onclick = () => {
    state.actions.splice(state.actions.indexOf(act), 1);
    if (!state.actions.length) state.actions.push(blankAction());
    markDirty();
    showItemActions();
  };
  line.classList.toggle("done", !!act.done);
  if (act.carried) {   // lives in a follow-up meeting now: read-only here, as in the table
    line.classList.add("carried");
    [text, owner, due].forEach(box => { box.readOnly = true; });
    line.querySelector("button").hidden = true;
  }
  flag();
  return line;
}

// Fills an agenda item's action list and its "+ Add action" button.
function fillActs(box, acts, itemId) {
  const add = document.createElement("button");
  add.className = "ghost sm";
  add.textContent = "+ Add action";
  add.onclick = () => {
    const act = blankAction();
    act.g = itemId;
    state.actions.push(act);
    markDirty();
    showItemActions();
    [...box.querySelectorAll(".act-line textarea")].pop().focus();
  };
  box.replaceChildren(...acts.map(actionLine), add);
}

function showItemActions() {
  state.agenda.forEach((row, i) => {
    const tr = $("#agendaRows").rows[i];
    if (!tr) return;
    fillActs(tr.querySelector(".rec-acts"), state.actions.filter(a => a.g === row.id), row.id);
    showRecord(tr, row);
  });
}

// Opens or closes a row's record without redrawing the agenda. Used by the timer too (timer.js).
function setRecord(row, open) {
  const tr = $("#agendaRows").rows[state.agenda.indexOf(row)];
  if (open) openRecs.add(row); else openRecs.delete(row);
  if (tr) showRecord(tr, row);
  return tr;
}

// Opens a row's record and puts the cursor in its Decision box.
function editRecord(row) {
  const tr = setRecord(row, true);
  if (!tr) return;
  tr.scrollIntoView({ block: "center" });
  tr.querySelector(".rec textarea").focus({ preventScroll: true });
}

// The Summary card in Wrap up: each agenda item with its decision and the actions that came out of
// it (owner and due date, or what is missing), then the actions that belong to no item (carried
// over from another meeting, or from an older file) when there are any, then the parking lot.
// Read-only: an item's title opens it in Run, where its decision and actions are edited.
function showSummary() {
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const actList = acts => {
    const ul = el("ul", "sum-acts");
    acts.forEach(a => {
      const li = el("li", a.done ? "done" : "", a.a.trim());
      const open = !a.done && !a.carried;
      const owner = (a.o || "").trim();
      li.append(el("span", open && !owner ? "warn" : "who", " \u00b7 " + (owner || "needs an owner")));
      li.append(el("span", open && !a.d ? "warn" : "who", " \u00b7 " + (a.d ? "due " + a.d : "needs a date")));
      if (a.done) li.append(el("span", "who", " \u00b7 done"));
      if (a.carried) li.append(el("span", "who", " \u00b7 carried to the follow-up"));
      ul.append(li);
    });
    return ul;
  };
  const written = state.actions.filter(a => a.a && a.a.trim());
  const rows = state.agenda.filter(agendaFilled);
  const blocks = rows.map(row => {
    const block = el("div", "sum-item");
    const title = el("button", "link", (row.t || "").trim() || "Untitled item");
    const acts = written.filter(a => a.g === row.id);
    title.title = "Open this item in Run";
    title.onclick = () => { setPhase("run"); editRecord(row); };
    block.append(title);
    if (row.d && row.d.trim()) {
      const line = el("div", "sum-dec");
      line.append(el("span", "tag", "Decision"), el("span", "", row.d.trim()));
      block.append(line);
    }
    if (acts.length) block.append(actList(acts));
    if (!(row.d && row.d.trim()) && !acts.length) block.append(el("div", "sum-none", "No decision or action recorded"));
    return block;
  });
  const loose = written.filter(a => !rows.some(r => r.id === a.g));
  if (loose.length) {
    const block = el("div", "sum-item");
    block.append(el("div", "sum-head", "Carried over / no agenda item"), actList(loose));
    blocks.push(block);
  }
  if (!blocks.length) blocks.push(el("div", "sum-none", "Nothing recorded yet."));

  const park = el("div", "sum-item");
  const items = parkingLines();
  const list = el("ul", "parked");
  list.append(...items.map(text => el("li", "", text)));
  park.append(el("div", "sum-head", "Parking lot"), items.length ? list : el("div", "sum-none", "Nothing parked."));
  blocks.push(park);
  $("#summary").replaceChildren(...blocks);
}

// The rail on the left of the agenda: when each item starts, as a clock time if the meeting has a
// start time and otherwise as minutes in ("+15"). "~" means an earlier item has no minutes, so the
// time is a guess. Rows that run past the timebox get the class "over", and the first one that
// starts after it "cut" (the "Timebox ends" line). Also refreshes the timer's current-item mark.
function showAgendaTimes() {
  const start = /^(\d\d):(\d\d)$/.exec(state.fields.time || "");
  const timebox = +state.fields.length || 0;
  const two = n => String(n).padStart(2, "0");
  let at = 0, unsure = false, cut = false;
  state.agenda.forEach((row, i) => {
    const tr = $("#agendaRows").rows[i];
    if (!tr) return;
    const filled = agendaFilled(row);
    const min = +row.m > 0 ? +row.m : 0;
    const late = filled && timebox > 0 && at >= timebox;
    const over = late || (filled && timebox > 0 && at + min > timebox);
    const cell = tr.querySelector("td.at");
    let text = "";
    if (filled) {
      const clockMin = start ? +start[1] * 60 + +start[2] + at : 0;
      text = (unsure ? "~" : "") + (start ? two(Math.floor(clockMin / 60) % 24) + ":" + two(clockMin % 60) : "+" + at);
    }
    cell.textContent = text;
    cell.title = !filled ? "" : over ? `Runs past the ${timebox} min timebox` : `Starts ${at} min in`;
    tr.classList.toggle("over", over);
    tr.classList.toggle("cut", late && !cut && i > 0);
    if (late) cut = true;
    if (filled && !min) unsure = true;
    at += min;
  });
  if (typeof markAgendaNow === "function") markAgendaNow();   // timer.js loads after this file
}

const attendeesChanged = () => { markDirty(); fillOwnerList(); };

// Attendees are plain strings, so edits write back by index.
const attendeeEditor = rowEditor({
  tbody: $("#attendeeRows"),
  list: () => state.attendees,
  blank: () => "",
  removeLabel: "Remove person",
  changed: attendeesChanged,
  cells: (name, i) => `<td><input type="text" id="att-${i}" aria-label="Attendee ${i + 1}" placeholder="${i ? "Next person" : "e.g. QA lead"}"></td>`,
  bind: (tr, name, i) => {
    const input = tr.querySelector("input");
    input.value = name;
    input.oninput = () => { state.attendees[i] = input.value; attendeesChanged(); };
    return [input];
  },
});

/* ---- Parking lot ----
   Saved as text in fields.parking, one item per line (it used to be one text box). Run edits it
   as a list; Wrap up shows it at the end of the summary (showSummary). */

let parked = [""];   // the rows being edited, empty ones included

const parkingLines = () => String(state.fields.parking || "").split("\n").map(s => s.trim()).filter(Boolean);

const parkingChanged = () => {
  state.fields.parking = parked.map(s => s.trim()).filter(Boolean).join("\n");
  markDirty();
};

const parkingEditor = rowEditor({
  tbody: $("#parkingRows"),
  list: () => parked,
  blank: () => "",
  removeLabel: "Remove item",
  changed: parkingChanged,
  cells: (text, i) => `<td><input type="text" id="park-${i}" aria-label="Parking lot item ${i + 1}" placeholder="${i ? "Next item" : "e.g. Controller remapping - Sam starts a thread"}"></td>`,
  bind: (tr, text, i) => {
    const input = tr.querySelector("input");
    input.value = text;
    input.oninput = () => { parked[i] = input.value; parkingChanged(); };
    return [input];
  },
});

function renderParking() {
  parked = parkingLines();
  if (!parked.length) parked = [""];
  parkingEditor.render();
}

// The line under the agenda: total minutes against the timebox, and items missing minutes.
// Also the bar above it: one segment per item, as wide as its share of the time; the grey end is
// spare time, and segments that end after the timebox are red.
function showAgendaSum() {
  const box = $("#agendaSum");
  const bar = $("#agendaBar");
  const items = agendaItems();
  const total = items.reduce((sum, it) => sum + (it.min || 0), 0);
  const timebox = +state.fields.length || 0;
  box.hidden = !items.length;
  bar.hidden = !total;
  if (!items.length) return;

  let end = 0;
  const segs = items.filter(it => it.min).map(it => {
    const seg = document.createElement("i");
    end += it.min;
    seg.style.flex = `${it.min} 1 0`;
    seg.title = `${it.title}: ${it.min} min`;
    seg.classList.toggle("over", timebox > 0 && end > timebox);
    return seg;
  });
  if (timebox > total) {
    const spare = document.createElement("i");
    spare.className = "spare";
    spare.style.flex = `${timebox - total} 1 0`;
    spare.title = `Spare: ${timebox - total} min`;
    segs.push(spare);
  }
  bar.replaceChildren(...segs);

  const missing = items.filter(it => it.min === null).length;
  let msg, warn = false;
  if (!timebox) msg = `Agenda adds up to ${total} min. Set a timebox to check it.`;
  else if (total > timebox) { msg = `Agenda is ${total} min but the timebox is ${timebox}. Cut or shorten items.`; warn = true; }
  else if (total < timebox) msg = `Agenda is ${total} of ${timebox} min: ${timebox - total} min spare.`;
  else msg = `Agenda fits the timebox: ${total} of ${timebox} min.`;
  if (missing) {
    msg += ` ${missing} item${missing > 1 ? "s have" : " has"} no minutes.`;
    warn = true;
  }
  box.textContent = msg;
  box.classList.toggle("warn", warn);
}

/* ---- Render: checklist ---- */

// Saved tick key for a checklist item, e.g. "before:send-agenda".
const checkKey = (phase, itemId) => `${phase.id}:${itemId}`;

// Files saved before v1.2.0 keyed ticks by position ("before-0") in the v1.0 checklist order.
// null = that item was removed (its advice now lives in a form field's tooltip).
const LEGACY_CHECKS = {
  before: ["needs-meeting", null, null, "trim-invites", null, "send-agenda", "prep-room", null],
  during: ["start-on-time", "state-goal", "keep-time", "park-tangents", "quiet-voices", "stay-neutral", "call-decision", "call-decision", "read-back", "end-on-time"],
  after:  ["send-notes", "log-actions", "update-docs", "parking-followup", "check-actions", null],
};

function migrateChecks(checks) {
  const out = {};
  Object.entries(checks || {}).forEach(([key, on]) => {
    const m = /^(before|during|after)-(\d+)$/.exec(key);
    if (!m) { out[key] = on; return; }
    const itemId = (LEGACY_CHECKS[m[1]] || [])[+m[2]];
    if (itemId && on) out[`${m[1]}:${itemId}`] = true;
  });
  return out;
}

function renderPhases() {
  const wrap = $("#phases");
  wrap.innerHTML = "";
  PHASES.forEach((p, pi) => {
    const sec = document.createElement("div");
    sec.className = "phase";
    sec.dataset.id = p.id;
    sec.innerHTML = `<div class="phase-head"><h3><span class="num">${pi + 1}</span>${p.name}</h3><span class="count" id="c-${p.id}"></span></div>`
      + `<div class="bar" id="b-${p.id}"><i></i></div><ul class="checks"></ul>`;
    const ul = sec.querySelector("ul");

    p.items.forEach(([itemId, title, desc]) => {
      const id = checkKey(p, itemId);
      const li = document.createElement("li");
      li.innerHTML = `<label for="chk-${id}"><input type="checkbox" id="chk-${id}"><span><span class="t"></span><span class="d"></span></span></label>`;
      li.querySelector(".t").textContent = title;
      li.querySelector(".d").textContent = desc;
      const cb = li.querySelector("input");
      cb.checked = !!state.checks[id];
      cb.onchange = () => {
        state.checks[id] = cb.checked;
        markDirty();
        updateCounts();
      };
      ul.appendChild(li);
    });

    wrap.appendChild(sec);
  });
  updateCounts();
}

function updateCounts() {
  PHASES.forEach(p => {
    const total = p.items.length;
    const done = p.items.filter(([itemId]) => state.checks[checkKey(p, itemId)]).length;
    const full = done === total;
    const count = $("#c-" + p.id);
    const bar = $("#b-" + p.id);
    count.textContent = `${done}/${total}`;
    count.classList.toggle("full", full);
    bar.classList.toggle("full", full);
    bar.querySelector("i").style.width = (done / total * 100) + "%";
  });
}

/* ---- Ticket links ---- */

// The tracker address that ticket keys are added to, e.g. "https://studio.atlassian.net/browse/".
// Set from the "..." menu and kept in this browser only (localStorage), never in meeting files.
const TICKET_KEY = "runsheet-ticket-url";
const isWebAddress = text => /^https?:\/\/\S+$/i.test(text);
let ticketBase = "";
try { ticketBase = localStorage.getItem(TICKET_KEY) || ""; } catch (e) {}
if (!isWebAddress(ticketBase)) ticketBase = "";

// Where a ticket links to, or "" for no link. A ticket that is already a full address links to
// itself. "{key}" in the tracker address marks where the key goes; without it, the key goes at the end.
function ticketHref(ticket) {
  const key = (ticket || "").trim();
  if (isWebAddress(key)) return key;
  if (!key || !ticketBase) return "";
  const part = encodeURIComponent(key);
  return ticketBase.includes("{key}") ? ticketBase.replace("{key}", part) : ticketBase + part;
}

// Opens in a new tab, so the run sheet stays where it is.
function ticketLink(text) {
  const a = document.createElement("a");
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

// "Ticket links..." in the menu opens a box for the tracker address.
function setupTicketLinks() {
  const box = $("#ticketBox");
  const input = $("#ticketUrl");
  const store = () => {
    const url = input.value.trim();
    if (url && !isWebAddress(url)) { toast("The address must start with http:// or https://"); return; }
    ticketBase = url;
    try { if (url) localStorage.setItem(TICKET_KEY, url); else localStorage.removeItem(TICKET_KEY); } catch (e) {}
    box.hidden = true;
    if (actionsOn) renderOpenActions();
    toast(url ? "Ticket links are on" : "Ticket links are off");
  };
  $("#ticketBtn").onclick = () => {
    input.value = ticketBase;
    box.hidden = false;
    input.focus();
  };
  $("#ticketSave").onclick = store;
  $("#ticketCancel").onclick = () => { box.hidden = true; };
  input.onkeydown = e => {
    if (e.key === "Enter") store();
    if (e.key === "Escape") box.hidden = true;
  };
}

/* ---- Action items ---- */

// Every open action needs one owner and a due date; past-due open actions are overdue.
const isOverdue = row => !!(row.d && !row.done && !row.carried && row.d < today());

// Names offered in each action's Owner box: the attendees, the note-taker and owners already used.
// Any other name can still be typed.
function fillOwnerList() {
  const seen = new Set();
  const names = [...attendeesToSave(), state.fields.notetaker, ...state.actions.map(a => a.o)]
    .map(n => (n || "").trim())
    .filter(n => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
  $("#ownerList").replaceChildren(...names.map(n => {
    const o = document.createElement("option");
    o.value = n;
    return o;
  }));
}

// "Follow-up of <meeting>" under the brief heading, linking back to the original.
function showFollows() {
  const line = $("#followsLine");
  line.hidden = !state.follows;
  if (!state.follows) return;
  const m = knownMeetings[state.follows];
  const link = document.createElement("button");
  link.className = "link";
  link.textContent = m ? [m.title || "Untitled meeting", m.date].filter(Boolean).join(", ") : "the previous meeting";
  link.onclick = () => guard(() => openMeeting(state.follows));
  line.replaceChildren(document.createTextNode("Follow-up of "), link);
}

function renderAll() {
  if (actionsOn) showActions(false);   // a meeting was opened or started: back to the run sheet
  FIELDS.forEach(f => { $("#f-" + f).value = state.fields[f] ?? ""; });
  if (!typeSel.value) typeSel.value = "general";
  showTip();
  showFollows();
  attendeeEditor.render();
  agendaEditor.render();
  renderParking();
  showAgendaSum();
  renderPhases();
  fillOwnerList();
  setStatus();
  highlight();
  setPhase(state.fields.date && state.fields.date < today() ? "wrap" : "plan");
  if (typeof resumeTimer === "function") resumeTimer(state.id);   // timer.js loads after this file
}

/* ---- Sidebar: meeting list and calendar ---- */

let meetings = [];   // summaries from the last loadList(), newest first

async function loadList() {
  const q = $("#search").value.trim();
  try {
    meetings = (await api("GET", "/api/meetings" + (q ? "?q=" + encodeURIComponent(q) : ""))) || [];
    meetings.forEach(m => { knownMeetings[m.id] = m; });
    if (!q) showActionCount();
    renderList(q);
    renderCalendar();
    highlight();
    showFollows();
  } catch (e) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Can't reach the server. Is the PowerShell window still running? (" + e.message + ")";
    $("#list").replaceChildren(d);
  }
}

// Upcoming (today and later, soonest first), then past meetings (newest first, as the server sends them).
function renderList(q) {
  const list = $("#list");
  list.innerHTML = "";
  if (!meetings.length) {
    const msg = q ? "No meetings match that search." : "No saved meetings yet. Fill in the run sheet and press Save.";
    list.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  const now = today();
  const upcoming = meetings.filter(m => m.date >= now).reverse();
  const past = meetings.filter(m => !(m.date >= now));
  const group = (name, items) => {
    if (!items.length) return;
    if (name) {
      const h = document.createElement("div");
      h.className = "group";
      h.textContent = name;
      list.appendChild(h);
    }
    items.forEach(m => list.appendChild(listItem(m)));
  };
  group("Upcoming", upcoming);
  group(upcoming.length ? "Past" : "", past);
}

// How prepared an upcoming meeting is: a goal, an agenda, and the Before checklist done.
function readiness(m) {
  const before = (PHASES.find(p => p.id === "before") || { items: [] }).items.map(([id]) => id);
  const done = before.filter(id => (m.beforeChecks || []).includes(id)).length;
  const missing = [];
  if (!m.hasGoal) missing.push("goal");
  if (!m.agendaCount) missing.push("agenda");
  if (done < before.length) missing.push(`prep ${done}/${before.length}`);
  return missing.length ? { text: "Needs " + missing.join(", "), ready: false } : { text: "Ready", ready: true };
}

function listItem(m) {
  const b = document.createElement("button");
  b.className = "item";
  b.dataset.id = m.id;

  const title = document.createElement("span");
  title.className = "t";
  title.textContent = m.title || "Untitled meeting";

  const meta = document.createElement("span");
  meta.className = "m";
  meta.textContent = [m.date, m.time, typeName(m.type)].filter(Boolean).join(" \u00b7 ");
  const pill = (text, cls) => {
    const p = document.createElement("span");
    p.className = "pill " + cls;
    p.textContent = text;
    meta.appendChild(p);
  };
  if (m.date >= today()) {
    const r = readiness(m);
    pill(r.text, r.ready ? "ready" : "prep");
  }
  if (m.openActions > 0) pill(m.openActions + " open", "open");
  if (m.overdueActions > 0) pill(m.overdueActions + " overdue", "overdue");

  b.append(title, meta);
  b.onclick = () => guard(() => openMeeting(m.id));
  return b;
}

// Month grid (Monday first, always 6 weeks so it doesn't jump), then the chosen day's meetings.
let calMonth = today().slice(0, 7);   // "yyyy-MM" shown
let calDay = today();                 // "yyyy-MM-dd" selected

function renderCalendar() {
  const [y, mo] = calMonth.split("-").map(Number);
  const first = new Date(y, mo - 1, 1);
  $("#calMonth").textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const byDay = {};
  meetings.forEach(m => { if (m.date) (byDay[m.date] = byDay[m.date] || []).push(m); });

  const grid = $("#calGrid");
  grid.innerHTML = "";
  ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach(d => {
    const h = document.createElement("span");
    h.className = "dow";
    h.textContent = d;
    grid.appendChild(h);
  });
  const now = today();
  const start = new Date(y, mo - 1, 1 - (first.getDay() + 6) % 7);
  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = isoDay(date);
    const count = (byDay[iso] || []).length;
    const b = document.createElement("button");
    b.className = "day" + (iso.slice(0, 7) !== calMonth ? " out" : "") + (iso === now ? " today" : "") + (iso === calDay ? " selected" : "");
    b.setAttribute("aria-label", date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
      + (count ? `, ${count} meeting${count > 1 ? "s" : ""}` : ""));
    if (iso === calDay) b.setAttribute("aria-pressed", "true");
    b.innerHTML = `<span>${date.getDate()}</span><i>${"<b></b>".repeat(Math.min(count, 3))}</i>`;
    b.onclick = () => {
      calDay = iso;
      calMonth = iso.slice(0, 7);
      renderCalendar();
    };
    grid.appendChild(b);
  }
  renderCalDay(byDay[calDay] || []);
}

function renderCalDay(items) {
  const box = $("#calDay");
  box.innerHTML = "";
  const [y, mo, d] = calDay.split("-").map(Number);
  const h = document.createElement("div");
  h.className = "group";
  h.textContent = new Date(y, mo - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  box.appendChild(h);
  items.slice().sort((a, b) => (a.time || "").localeCompare(b.time || "")).forEach(m => box.appendChild(listItem(m)));
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No meetings this day.";
    box.appendChild(e);
  }
  const plan = document.createElement("button");
  plan.className = "ghost plan";
  plan.textContent = "+ Plan a meeting on this day";
  plan.onclick = () => guard(() => newMeeting(calDay));
  box.appendChild(plan);
  highlight();
}

function showMonth(delta) {
  const [y, mo] = calMonth.split("-").map(Number);
  calMonth = isoDay(new Date(y, mo - 1 + delta, 1)).slice(0, 7);
  renderCalendar();
}

function setupCalendar() {
  $("#calPrev").onclick = () => showMonth(-1);
  $("#calNext").onclick = () => showMonth(1);
  $("#calToday").onclick = () => { calDay = today(); calMonth = calDay.slice(0, 7); renderCalendar(); };
}

function highlight() {
  document.querySelectorAll(".item").forEach(b => b.classList.toggle("active", b.dataset.id === state.id));
}

/* ---- Open actions from every meeting (the Actions button) ---- */

let actionsOn = false;
let openActions = [];   // rows from GET /api/actions, soonest due first

// Swaps the run sheet for the actions view and back. "#actions" in the address opens it on load.
function showActions(on) {
  actionsOn = on;
  $("#sheet").hidden = on;
  $("#actionsView").hidden = !on;
  $("#jumpNav").hidden = on;
  $("#actionsBtn").setAttribute("aria-pressed", String(on));
  history.replaceState(null, "", on ? "#actions" : location.pathname + location.search);
  if (on) {
    loadActions();
    window.scrollTo(0, 0);
  }
}

// The count on the Actions button, from the unfiltered meeting list.
function showActionCount() {
  const sum = key => meetings.reduce((n, m) => n + (m[key] || 0), 0);
  const open = sum("openActions");
  const overdue = sum("overdueActions");
  const pill = $("#actionsCount");
  pill.hidden = !open;
  pill.textContent = open;
  pill.className = "pill " + (overdue ? "overdue" : "prep");
  pill.title = overdue ? `${overdue} overdue` : "";
}

async function loadActions() {
  try {
    openActions = (await api("GET", "/api/actions")) || [];
  } catch (e) {
    openActions = [];
    toast("Couldn't load the actions: " + e.message);
  }
  renderOpenActions();
}

// Grouped by due date. The filter box matches the action, owner, ticket or meeting.
function renderOpenActions() {
  const q = $("#actFilter").value.trim().toLowerCase();
  const rows = openActions.filter(r => !q || [r.a, r.o, r.t, r.meeting].join("\n").toLowerCase().includes(q));
  const now = today();
  const week = new Date();
  week.setDate(week.getDate() + 7);
  const soon = isoDay(week);
  const groups = [
    ["Overdue", r => r.d && r.d < now],
    ["Next 7 days", r => r.d >= now && r.d <= soon],
    ["Later", r => r.d > soon],
    ["No due date", r => !r.d],
  ];

  const tbody = $("#openActionRows");
  tbody.innerHTML = "";
  groups.forEach(([name, belongs]) => {
    const items = rows.filter(belongs);
    if (!items.length) return;
    const tr = document.createElement("tr");
    tr.className = "grp";
    tr.innerHTML = `<th colspan="6">${name} <span class="count">${items.length}</span></th>`;
    tbody.appendChild(tr);
    items.forEach(r => tbody.appendChild(openActionRow(r, now)));
  });

  $("#openActionsTable").hidden = !rows.length;
  const empty = $("#openActionsEmpty");
  empty.hidden = rows.length > 0;
  empty.textContent = openActions.length ? "No open actions match that filter."
    : "No open actions. Everything is done or carried to a follow-up.";
}

function openActionRow(r, now) {
  const tr = document.createElement("tr");
  tr.classList.toggle("done", !!r.done);
  const cell = (cls, text) => {
    const td = document.createElement("td");
    td.className = cls;
    td.textContent = text;
    tr.appendChild(td);
    return td;
  };

  const tick = cell("c", "");
  if (r.id) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!r.done;
    box.setAttribute("aria-label", "Done: " + r.a);
    box.onchange = () => tickAction(r, box, tr);
    tick.appendChild(box);
  } else {
    // Saved before actions had ids (v1.2.0): opening and saving the meeting gives it one.
    tick.textContent = "\u2013";
    tick.title = "Open the meeting and save it, then tick it off here";
  }

  cell("a", r.a);
  cell(r.o ? "" : "warn", r.o || "No owner");
  cell("due " + (!r.d ? "warn" : r.d < now ? "overdue" : ""), r.d || "No date");
  const ticket = cell("", r.t);
  const href = ticketHref(r.t);
  if (href) {
    const a = ticketLink(r.t);
    a.href = href;
    ticket.replaceChildren(a);
  }

  const from = cell("", "");
  const link = document.createElement("button");
  link.className = "link";
  link.textContent = r.meeting || "Untitled meeting";
  link.onclick = () => guard(() => openMeeting(r.meetingId));
  from.appendChild(link);
  if (r.meetingDate) {
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = r.meetingDate;
    from.appendChild(when);
  }
  return tr;
}

// Ticks one action in its meeting file. The row stays (struck through) so it can be unticked.
async function tickAction(r, box, tr) {
  const here = r.meetingId === state.id;
  if (here && dirty) {
    box.checked = !box.checked;
    toast("That action is in the meeting you have open. Save it first.");
    return;
  }
  try {
    await api("PUT", `/api/meetings/${r.meetingId}/actions/${encodeURIComponent(r.id)}`, { done: box.checked });
    r.done = box.checked;
    tr.classList.toggle("done", r.done);
    if (here) {
      const mine = state.actions.find(a => a.id === r.id);
      if (mine) mine.done = r.done;
      showItemActions();
      showSummary();
    }
    loadList();
  } catch (e) {
    box.checked = !box.checked;
    toast("Couldn't update that action: " + e.message);
  }
}

/* ---- Commands: open, save, new, follow-up, delete ---- */

// Brings a saved meeting (or a stored draft) up to the current format.
function fromSaved(m) {
  const fields = Object.assign({}, m.fields);
  const agenda = Array.isArray(m.agenda)
    ? m.agenda.map(r => ({ id: r.id, t: String(r.t || ""), m: +r.m > 0 ? +r.m : null, d: String(r.d || ""), n: String(r.n || "") }))
    : agendaFromText(fields.agenda);   // before v1.3.0: free text in fields.agenda
  agenda.forEach(r => { if (!r.id) r.id = newActionId(); });   // before v1.17.0: no agenda item ids
  delete fields.agenda;
  const attendees = Array.isArray(m.attendees)
    ? m.attendees.map(n => String(n || ""))
    : attendeesFromText(fields.attendees);   // before v1.5.0: free text in fields.attendees
  delete fields.attendees;
  const actions = (m.actions && m.actions.length) ? m.actions : [blankAction()];
  actions.forEach(a => { if (!a.id) a.id = newActionId(); });   // before v1.2.0: no action ids
  return {
    id: m.id || null,
    savedAt: m.savedAt,
    follows: m.follows || null,
    fields,
    checks: migrateChecks(m.checks),
    agenda: agenda.length ? agenda : [blankAgendaRow()],
    attendees: attendees.length ? attendees : [""],
    actions,
  };
}

async function openMeeting(id) {
  try {
    const m = await api("GET", "/api/meetings/" + encodeURIComponent(id));
    state = fromSaved(m);
    state.id = state.id || id;
    markClean();
    renderAll();
    window.scrollTo(0, 0);
  } catch (e) {
    toast("Couldn't open that meeting: " + e.message);
  }
}

async function save() {
  const body = {
    fields: state.fields,
    checks: state.checks,
    agenda: agendaToSave(),
    attendees: attendeesToSave(),
    actions: state.actions.filter(a => a.a || a.o || a.d || a.t),   // drop empty rows
    follows: state.follows || undefined,
  };
  try {
    const m = state.id
      ? await api("PUT", "/api/meetings/" + state.id, body)
      : await api("POST", "/api/meetings", body);
    if (!state.id) timerMeetingSaved(m.id);
    state.id = m.id;
    state.savedAt = m.savedAt;
    markClean();
    setStatus();
    toast("Saved");
    loadList();
  } catch (e) {
    toast("Save failed: " + e.message);
  }
}

// A blank meeting, on the given day if there is one (from the calendar).
function newMeeting(date) {
  state = blank();
  if (date) state.fields.date = date;
  markClean();
  renderAll();
  $("#f-title").focus();
}

// New unsaved meeting with the same brief, today's date and the open actions carried over.
// When it's saved, the server marks those actions "carried" in this meeting (see MeetingStore.psm1).
function followUp() {
  const fields = { date: today() };
  FOLLOW_UP_FIELDS.forEach(k => { if (state.fields[k]) fields[k] = state.fields[k]; });
  // Carried actions keep their id but not their agenda item: the follow-up's items are new ones.
  const open = state.actions.filter(a => a.a && !a.done && !a.carried).map(a => {
    const copy = Object.assign({}, a);
    delete copy.g;
    return copy;
  });
  const agenda = state.agenda.map(r => ({ id: newActionId(), t: r.t, m: r.m }));   // the items, not what was recorded on them
  const attendees = state.attendees.slice();
  state = { id: null, follows: state.id, fields, checks: {}, agenda, attendees, actions: open.length ? open : [blankAction()] };
  renderAll();
  markDirty();
  toast(open.length ? `Carried over ${open.length} open action${open.length > 1 ? "s" : ""}` : "Brief copied to a new meeting");
}

async function deleteMeeting() {
  try {
    await api("DELETE", "/api/meetings/" + state.id);
    state = blank();
    markClean();
    renderAll();
    loadList();
    toast("Meeting deleted");
  } catch (e) {
    toast("Delete failed: " + e.message);
  }
}

/* ---- Copy notes (summary for Slack or email; as Markdown for a wiki, Confluence or GitHub) ---- */

// Plain text by default. With md, the same notes as Markdown: headings, bold labels, and tickets
// as links where there is something to link to (see ticketHref).
function notes(md) {
  const f = state.fields;
  const lines = s => (s || "").split("\n").map(x => x.trim()).filter(Boolean);
  const bullets = arr => arr.map(x => "- " + x).join("\n");
  const gap = md ? "\n" : "";   // Markdown needs an empty line between paragraphs
  const label = text => md ? `**${text}:**` : `${text}:`;
  const section = (name, body) => `${md ? "## " + name : "\n" + name.toUpperCase()}\n${gap}${body}\n${gap}`;

  let o = `${md ? "# " : ""}${f.title || "Meeting notes"}\n${gap}`;
  o += [f.date, f.time, typeName(f.type), f.length ? f.length + " min" : ""].filter(Boolean).join(" \u00b7 ") + "\n\n";
  if (f.goal) o += `${label("Goal")} ${f.goal}\n${gap}`;
  const people = attendeesToSave();
  if (people.length) o += `${label("Attendees")} ${people.join(", ")}\n${gap}`;

  // Decisions made on agenda items come first, each with its item, then the ones from the Decisions box.
  const items = agendaToSave();
  const decisions = items.filter(r => r.d).map(r => `${r.t}: ${r.d}`).concat(lines(f.decisions));
  o += section("Decisions", decisions.length ? bullets(decisions) : "- None recorded");

  const acts = state.actions.filter(a => a.a && a.a.trim());
  const status = a => {
    const text = a.done ? "done" : a.carried ? "carried to follow-up" : "";
    return !text ? "" : md ? `**${text[0].toUpperCase()}${text.slice(1)}:** ` : `[${text}] `;
  };
  const ticket = a => {
    const href = md ? ticketHref(a.t) : "";
    return !a.t ? "" : ", " + (href && href !== a.t.trim() ? `[${a.t.trim()}](${href})` : a.t);
  };
  const actText = a => `${status(a)}${a.a} (Owner: ${a.o || "UNASSIGNED"}, Due: ${a.d || "TBD"}${ticket(a)})`;
  // Under their agenda item where they have one (then "Other"); a plain list when none do.
  const groups = items.map(r => [r.t, acts.filter(a => a.g === r.id)]).filter(([, list]) => list.length);
  const loose = acts.filter(a => !items.some(r => r.id === a.g));
  if (groups.length && loose.length) groups.push(["Other", loose]);
  o += section("Actions", !acts.length ? "- None" : !groups.length ? bullets(acts.map(actText))
    : groups.map(([name, list]) => `${md ? `**${name}**` : name}\n${gap}${bullets(list.map(actText))}`).join("\n" + gap));

  const discussed = items.filter(r => r.n).map(r => `${md ? `**${r.t}**` : r.t}\n${gap}${bullets(lines(r.n))}`);
  if (discussed.length) o += section("Discussion", discussed.join("\n" + gap));

  const parking = lines(f.parking);
  if (parking.length) o += section("Parking lot", bullets(parking));
  return o.trimEnd() + "\n";
}

function copyNotes(md) {
  const txt = notes(md);
  const box = $("#fallbackBox");
  const area = $("#copyFallback");
  const fallback = () => {
    area.value = txt;
    box.hidden = false;
    area.select();
  };
  box.hidden = true;
  try {
    navigator.clipboard.writeText(txt).then(() => toast(md ? "Notes copied as Markdown." : "Notes copied. Paste them into Slack or email."), fallback);
  } catch (e) {
    fallback();
  }
}

/* ---- Local draft: unsaved work survives a browser crash or a closed server window ---- */

// Kept in this browser only (localStorage), never sent to the server. One draft at a time.
const DRAFT_KEY = "runsheet-draft";
let draftTimer = null;

function storeDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: new Date().toISOString(), state })); } catch (e) {}
  }, 500);
}

function clearDraft() {
  clearTimeout(draftTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
}

// On page load: offer to bring back unsaved work from last time.
function offerDraft() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) {}
  if (!draft || !draft.state || !draft.state.fields) return;
  const title = draft.state.fields.title || "Untitled meeting";
  const when = new Date(draft.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  ask(`Unsaved changes to "${title}" from ${when} were found. Restore them?`, "Restore", () => {
    state = fromSaved(draft.state);
    renderAll();
    resumeTimer(state.id || UNSAVED);
    markDirty();
  }, clearDraft);
}

/* ---- Help tooltips ---- */

// Turns each <label data-help="..."> into the label plus a (?) button with a tooltip.
// The tip shows while hovering the button; a click (or tap) pins it open until Escape or a click elsewhere.
// The field's input (label "for", or data-for on a non-label) is described by the tip for screen readers.
function setupHelp() {
  document.querySelectorAll("[data-help]").forEach(label => {
    const target = label.htmlFor || label.dataset.for;
    const row = document.createElement("div");
    row.className = "label-row";
    label.replaceWith(row);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "help";
    btn.textContent = "?";
    btn.tabIndex = -1;   // keep Tab moving from field to field
    btn.setAttribute("aria-label", "Help");
    btn.setAttribute("aria-expanded", "false");

    const tip = document.createElement("span");
    tip.className = "help-tip";
    tip.id = "help-" + target;
    tip.setAttribute("role", "tooltip");
    tip.textContent = label.dataset.help;

    row.append(label, btn, tip);
    document.getElementById(target).setAttribute("aria-describedby", tip.id);

    btn.onclick = () => {
      const open = !row.classList.contains("open");
      closeHelp();
      row.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    };
  });

  document.addEventListener("click", e => { if (!e.target.closest(".label-row")) closeHelp(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeHelp(); });
}

function closeHelp() {
  document.querySelectorAll(".label-row.open").forEach(row => {
    row.classList.remove("open");
    row.querySelector(".help").setAttribute("aria-expanded", "false");
  });
}

/* ---- Backup, restore, CSV export ("..." menu) ---- */

// Downloads go through a link with "download", so the page isn't unloaded (no unsaved-changes prompt).
function download(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Sends a backup zip to the server, which adds the meetings that aren't here yet.
async function restoreBackup(file) {
  try {
    const r = await fetch("/api/backup", { method: "POST", headers: { "X-Run-Sheet": "1", "Content-Type": "application/zip" }, body: file });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
    const parts = [`Restored ${data.added} meeting${data.added === 1 ? "" : "s"}`];
    if (data.skipped) parts.push(`${data.skipped} already here`);
    if (data.invalid) parts.push(`${data.invalid} unreadable`);
    toast(parts.join(", "));
    loadList();
  } catch (e) {
    toast("Restore failed: " + e.message);
  }
}

/* ---- Top bar: "..." menu and the meetings sidebar toggle ---- */

// The "..." menu holds the less-used commands. Picking one, Esc or a click elsewhere closes it.
function setupMenu() {
  const btn = $("#moreBtn");
  const menu = $("#moreMenu");
  const setOpen = open => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.onclick = () => setOpen(menu.hidden);
  menu.addEventListener("click", e => { if (e.target.closest("button")) setOpen(false); });
  document.addEventListener("click", e => { if (!e.target.closest(".menu-wrap")) setOpen(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") setOpen(false); });
}

// Theme entry in the "..." menu: opens the list of THEMES under it, with a tick on the one in use.
// theme.js holds the choice and applies it. The menu stays open, so themes can be tried in turn.
function setupTheme() {
  const btn = $("#themeBtn");
  const list = $("#themeList");
  const show = () => {
    btn.textContent = "Theme: " + THEMES.find(t => t[0] === themeChoice)[1];
    list.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.theme === themeChoice)));
  };
  THEMES.forEach(([key, name]) => {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitemradio");
    b.dataset.theme = key;
    b.textContent = name;
    b.onclick = e => {
      e.stopPropagation();
      themeChoice = key;
      try { if (key) localStorage.setItem(THEME_KEY, key); else localStorage.removeItem(THEME_KEY); } catch (e) {}
      applyTheme();
      show();
    };
    list.append(b);
  });
  btn.onclick = e => {
    e.stopPropagation();
    list.hidden = !list.hidden;
    btn.setAttribute("aria-expanded", String(!list.hidden));
  };
  show();
}

// Hiding the sidebar gives the run sheet the full width during a meeting.
// Remembered in this browser only; the page works the same without it.
const SIDE_KEY = "runsheet-side-off";

function setSidebar(off) {
  $("#app").classList.toggle("side-off", off);
  const btn = $("#sideBtn");
  btn.setAttribute("aria-expanded", String(!off));
  btn.title = off ? "Show meetings list" : "Hide meetings list";
  try { localStorage.setItem(SIDE_KEY, off ? "1" : ""); } catch (e) {}
}

function setupSidebar() {
  let off = false;
  try { off = localStorage.getItem(SIDE_KEY) === "1"; } catch (e) {}
  setSidebar(off);
  $("#sideBtn").onclick = () => setSidebar(!$("#app").classList.contains("side-off"));
}

/* ---- Wire up events and start ---- */

FIELDS.forEach(f => {
  const el = $("#f-" + f);
  el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
    state.fields[f] = el.value;
    markDirty();
    if (f === "type") showTip();
    if (f === "length") showAgendaSum();
    if (f === "length" || f === "time") showAgendaTimes();
    if (f === "notetaker") fillOwnerList();
  });
});

$("#confirmNo").onclick = () => {
  $("#confirmBox").hidden = true;
  const fn = pendingNo;
  pending = pendingNo = null;
  if (fn) fn();
};
$("#confirmYes").onclick = () => {
  $("#confirmBox").hidden = true;
  const fn = pending;
  pending = pendingNo = null;
  if (fn) fn();
};

$("#search").addEventListener("input", () => {
  clearTimeout(listTimer);
  listTimer = setTimeout(loadList, 200);
});

$("#saveBtn").onclick = save;
$("#newBtn").onclick = () => guard(newMeeting);
$("#followBtn").onclick = () => guard(followUp);
$("#deleteBtn").onclick = () => ask(`Delete "${state.fields.title || "Untitled meeting"}" permanently?`, "Delete", deleteMeeting);
$("#addAgenda").onclick = () => agendaEditor.add(state.agenda.length);
$("#addAttendee").onclick = () => attendeeEditor.add(state.attendees.length);
$("#addParking").onclick = () => parkingEditor.add(parked.length);
$("#actionsBtn").onclick = () => showActions(!actionsOn);
$("#actionsBack").onclick = () => showActions(false);
$("#actFilter").addEventListener("input", renderOpenActions);
$("#copyBtn").onclick = $("#copyStripBtn").onclick = () => copyNotes(false);
$("#copyMdBtn").onclick = $("#copyMdBtn2").onclick = () => copyNotes(true);
$("#followBtn2").onclick = () => guard(followUp);
document.querySelectorAll("#phaseTabs button").forEach(b => b.onclick = () => {
  if (actionsOn) showActions(false);
  setPhase(b.dataset.phase);
  window.scrollTo(0, 0);
});
$("#backupBtn").onclick = () => download("/api/backup");
$("#csvBtn").onclick = () => download("/api/actions.csv");
$("#restoreBtn").onclick = () => $("#restoreFile").click();
$("#restoreFile").onchange = e => {
  const file = e.target.files[0];
  e.target.value = "";   // so picking the same file again still fires
  if (file) restoreBackup(file);
};

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});
window.addEventListener("beforeunload", e => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

setupHelp();
setupMenu();
setupTheme();
setupSidebar();
setupCalendar();
setupTicketLinks();
fillTypeOptions();
renderAll();
loadList();
offerDraft();
if (location.hash === "#actions") showActions(true);
