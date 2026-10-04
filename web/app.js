/*
  Meeting Run Sheet page behaviour.
  Checklist items and meeting-type tips live in content.js (PHASES, TYPES).
*/

// Brief/record fields saved under meeting.fields. Each has an element with id "f-<name>" in index.html.
// The agenda and attendees are separate lists: meeting.agenda and meeting.attendees (see below).
// Old files may still have fields.decider (box removed in v1.5.0); it is kept but not shown.
const FIELDS = ["title", "type", "date", "time", "length", "goal", "notetaker", "decisions", "parking", "reflect"];
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
const blankAgendaRow = () => ({ t: "", m: null });
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
  storeDraft();
}

// Call after the page matches what's saved (or the user chose to throw changes away).
function markClean() {
  dirty = false;
  clearDraft();
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

/* ---- Agenda: rows of { t: title, m: minutes } ---- */

// Filled-in rows as [{ title, min }] (min is null when not set). Used by the agenda check and the timer.
function agendaItems() {
  return (state.agenda || [])
    .filter(r => (r.t && r.t.trim()) || r.m)
    .map(r => ({ title: (r.t || "").trim() || "Untitled item", min: +r.m > 0 ? +r.m : null }));
}

// Rows to save: drops empty ones.
const agendaToSave = () => agendaItems().map(it => ({ t: it.title, m: it.min }));

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
     changed()        called after any edit                                            */
function rowEditor({ tbody, list, blank, cells, bind, changed, movable = false, removeLabel }) {
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
  };

  ed.add = at => {
    list().splice(at, 0, blank());
    changed();
    ed.render();
    tbody.rows[at].querySelector("input").focus();
  };

  ed.move = (from, to) => {
    const rows = list();
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    changed();
    ed.render();
    // Keep focus on the same arrow so the row can be moved several places with the keyboard.
    const arrow = tbody.rows[to].querySelector(`[data-mv="${to > from ? 1 : -1}"]`);
    (arrow.disabled ? tbody.rows[to].querySelector("input") : arrow).focus();
  };

  return ed;
}

const agendaChanged = () => { markDirty(); showAgendaSum(); showTemplateOffer(); };

const agendaEditor = rowEditor({
  tbody: $("#agendaRows"),
  list: () => state.agenda,
  blank: blankAgendaRow,
  movable: true,
  removeLabel: "Remove item",
  changed: agendaChanged,
  cells: (row, i) => `<td class="n">${i + 1}</td>
    <td><input type="text" id="ag-t-${i}" aria-label="Agenda item ${i + 1}" placeholder="${i ? "Next item" : "e.g. Context and goal"}"></td>
    <td class="min"><input type="number" id="ag-m-${i}" min="1" step="1" aria-label="Minutes for item ${i + 1}" placeholder="min"></td>`,
  bind: (tr, row, i) => {
    const title = tr.querySelector(`#ag-t-${i}`);
    const min = tr.querySelector(`#ag-m-${i}`);
    title.value = row.t || "";
    min.value = row.m ?? "";
    title.oninput = () => { row.t = title.value; agendaChanged(); };
    min.oninput = () => { row.m = min.value === "" ? null : +min.value; agendaChanged(); };
    return [title, min];
  },
});

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

// The line under the agenda: total minutes against the timebox, and items missing minutes.
function showAgendaSum() {
  const box = $("#agendaSum");
  const items = agendaItems();
  box.hidden = !items.length;
  if (!items.length) return;

  const total = items.reduce((sum, it) => sum + (it.min || 0), 0);
  const missing = items.filter(it => it.min === null).length;
  const timebox = +state.fields.length || 0;
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

// The "Use template" button: shown only while the agenda is empty, for the chosen meeting type
// (AGENDAS in content.js).
function showTemplateOffer() {
  const btn = $("#useTemplate");
  btn.hidden = !AGENDAS[typeSel.value] || agendaItems().length > 0;
  btn.textContent = "Use template: " + typeName(typeSel.value);
}

// Copies the type's starter agenda in, and sets the timebox to its total if there isn't one yet.
function useTemplate() {
  const rows = AGENDAS[typeSel.value];
  state.agenda = rows.map(([t, m]) => ({ t, m }));
  if (!+state.fields.length) {
    state.fields.length = String(rows.reduce((sum, [, m]) => sum + m, 0));
    $("#f-length").value = state.fields.length;
  }
  agendaEditor.render();
  agendaChanged();
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

// The arrow next to an action's Ticket box: shown when there is something to link to.
function linkTicket(tr, row) {
  const go = tr.querySelector(".ticket-go");
  const href = ticketHref(row.t);
  go.hidden = !href;
  if (href) go.href = href;
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
    renderActions();
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

/* ---- Render: action items ---- */

// Every open action needs one owner and a due date; past-due open actions are overdue.
const isOverdue = row => !!(row.d && !row.done && !row.carried && row.d < today());

function flagAction(tr, row) {
  const open = !!(row.a && row.a.trim()) && !row.done && !row.carried;
  const flag = (k, on, why) => {
    const input = tr.querySelector(`[data-k="${k}"]`);
    input.classList.toggle("missing", on);
    input.title = on ? why : "";
  };
  flag("o", open && !(row.o && row.o.trim()), "Needs one owner");
  flag("d", open && !row.d, "Needs a due date");
  const due = tr.querySelector('[data-k="d"]');
  due.classList.toggle("overdue", isOverdue(row));
  if (isOverdue(row)) due.title = "Overdue";
}

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

function renderActions() {
  const tbody = $("#actionRows");
  tbody.innerHTML = "";
  state.actions.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.classList.toggle("done", !!row.done);
    tr.innerHTML = `<td class="c"><input type="checkbox" id="act-done-${i}" aria-label="Done"></td>
      <td><input type="text" id="act-a-${i}" aria-label="Action" placeholder="What gets done"></td>
      <td><input type="text" id="act-o-${i}" list="ownerList" aria-label="Owner" placeholder="Name"></td>
      <td><input type="date" id="act-d-${i}" aria-label="Due"></td>
      <td><div class="tk"><input type="text" id="act-t-${i}" aria-label="Ticket" placeholder="PROJ-123"></div></td>
      <td class="x"><button aria-label="Remove action">&times;</button></td>`;

    // a = action, o = owner, d = due date, t = ticket
    ["a", "o", "d", "t"].forEach(k => {
      const input = tr.querySelector(`#act-${k}-${i}`);
      input.dataset.k = k;
      input.value = row[k] || "";
      input.oninput = () => {
        row[k] = input.value;
        flagAction(tr, row);
        if (k === "t") linkTicket(tr, row);
        markDirty();
      };
    });
    const go = ticketLink("↗");
    go.className = "ticket-go";
    go.title = "Open the ticket";
    go.setAttribute("aria-label", go.title);
    tr.querySelector(".tk").appendChild(go);
    linkTicket(tr, row);
    // On leaving the box, not while typing, so the suggestions don't shift under the cursor.
    tr.querySelector(`#act-o-${i}`).onchange = fillOwnerList;

    const doneBox = tr.querySelector(`#act-done-${i}`);
    doneBox.checked = !!row.done;
    doneBox.onchange = () => {
      row.done = doneBox.checked;
      tr.classList.toggle("done", row.done);
      flagAction(tr, row);
      markDirty();
    };
    flagAction(tr, row);
    if (row.carried) showCarried(tr, row);

    tr.querySelector("td.x button").onclick = () => {
      state.actions.splice(i, 1);
      if (!state.actions.length) state.actions.push(blankAction());
      markDirty();
      renderActions();
    };

    tbody.appendChild(tr);
  });
}

// A row that was carried into a follow-up meeting: read-only here, with a link to where it lives now.
function showCarried(tr, row) {
  tr.classList.add("carried");
  tr.querySelectorAll("input").forEach(input => { input.readOnly = true; });
  const go = document.createElement("button");
  go.className = "carried-link";
  go.innerHTML = "&#8618;";
  go.title = "Carried to a follow-up meeting. Click to open it.";
  go.setAttribute("aria-label", go.title);
  go.onclick = () => guard(() => openMeeting(row.carried));
  tr.querySelector("td.c").replaceChildren(go);
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
  showAgendaSum();
  showTemplateOffer();
  renderPhases();
  renderActions();
  fillOwnerList();
  setStatus();
  highlight();
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
    tick.textContent = "–";
    tick.title = "Open the meeting to tick this one off";
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
      renderActions();
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
    ? m.agenda.map(r => ({ t: String(r.t || ""), m: +r.m > 0 ? +r.m : null }))
    : agendaFromText(fields.agenda);   // before v1.3.0: free text in fields.agenda
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
  const open = state.actions.filter(a => a.a && !a.done && !a.carried).map(a => Object.assign({}, a));
  const agenda = state.agenda.map(r => Object.assign({}, r));
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

function addAction() {
  state.actions.push(blankAction());
  markDirty();
  renderActions();
  $(`#act-a-${state.actions.length - 1}`).focus();
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

  const decisions = lines(f.decisions);
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
  o += section("Actions", acts.length ? bullets(acts.map(actText)) : "- None");

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
    if (f === "type") { showTip(); showTemplateOffer(); }
    if (f === "length") showAgendaSum();
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
$("#addAction").onclick = addAction;
$("#addAgenda").onclick = () => agendaEditor.add(state.agenda.length);
$("#useTemplate").onclick = useTemplate;
$("#addAttendee").onclick = () => attendeeEditor.add(state.attendees.length);
$("#actionsBtn").onclick = () => showActions(!actionsOn);
$("#actionsBack").onclick = () => showActions(false);
$("#actFilter").addEventListener("input", renderOpenActions);
$("#copyBtn").onclick = () => copyNotes(false);
$("#copyMdBtn").onclick = () => copyNotes(true);
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
setupSidebar();
setupCalendar();
setupTicketLinks();
fillTypeOptions();
renderAll();
loadList();
offerDraft();
if (location.hash === "#actions") showActions(true);
