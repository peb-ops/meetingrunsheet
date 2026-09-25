/*
  Meeting Run Sheet page behaviour.
  Checklist items and meeting-type tips live in content.js (PHASES, TYPES).
*/

// Brief/record fields saved under meeting.fields. Each has an element with id "f-<name>" in index.html.
const FIELDS = ["title", "type", "date", "length", "goal", "decider", "notetaker", "attendees", "agenda", "decisions", "parking", "reflect"];
// Fields copied into a follow-up meeting.
const FOLLOW_UP_FIELDS = ["title", "type", "length", "goal", "decider", "notetaker", "attendees", "agenda"];

const $ = s => document.querySelector(s);
const typeSel = $("#f-type");

/* ---- State ---- */

function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
// Action ids stay the same when an action is carried into a follow-up meeting.
const newActionId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const blankAction = () => ({ id: newActionId(), a: "", o: "", d: "", t: "", done: false });
const blank = () => ({ id: null, follows: null, fields: { type: "general", date: today() }, checks: {}, actions: [blankAction()] });
const typeName = key => (TYPES[key] || TYPES.general)[0];

let state = blank();
let dirty = false;
let pending = null;   // callback waiting on the inline confirm bar
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
}

function ask(message, yesLabel, fn) {
  $("#confirmMsg").textContent = message;
  $("#confirmYes").textContent = yesLabel;
  pending = fn;
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

/* ---- Agenda: "Item (N min)" lines ---- */

// Returns [{ title, min }] for each non-empty line. min is null when the line has no minutes.
// Accepts "(15 min)", "15 min", "15m" or "15 minutes" at the end of the line, and ignores "1." numbering.
function parseAgenda(text) {
  return (text || "").split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const m = /\(?\s*(\d+)\s*(?:m|min|mins|minutes)\s*\)?\s*$/i.exec(line);
    const title = (m ? line.slice(0, m.index) : line).replace(/^\d+[.)]\s*/, "").replace(/[\s-]+$/, "");
    return { title: title || line, min: m ? +m[1] : null };
  });
}

// The line under the agenda: total minutes against the timebox, and items missing minutes.
function showAgendaSum() {
  const box = $("#agendaSum");
  const items = parseAgenda(state.fields.agenda);
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
    msg += ` ${missing} item${missing > 1 ? "s have" : " has"} no minutes, e.g. "Review crashes (15 min)".`;
    warn = true;
  }
  box.textContent = msg;
  box.classList.toggle("warn", warn);
}

/* ---- Render: checklist ---- */

// Saved tick key for a checklist item, e.g. "before:needs-meeting".
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
    sec.className = "panel phase";
    sec.innerHTML = `<div class="phase-head"><h3><span class="num">0${pi + 1}</span>${p.name}</h3><span class="count" id="c-${p.id}"></span></div>`
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

function renderActions() {
  const tbody = $("#actionRows");
  tbody.innerHTML = "";
  state.actions.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.classList.toggle("done", !!row.done);
    tr.innerHTML = `<td class="c"><input type="checkbox" id="act-done-${i}" aria-label="Done"></td>
      <td><input type="text" id="act-a-${i}" aria-label="Action" placeholder="What gets done"></td>
      <td><input type="text" id="act-o-${i}" aria-label="Owner" placeholder="Name"></td>
      <td><input type="date" id="act-d-${i}" aria-label="Due"></td>
      <td><input type="text" id="act-t-${i}" aria-label="Ticket" placeholder="PROJ-123"></td>
      <td class="x"><button aria-label="Remove action">&times;</button></td>`;

    // a = action, o = owner, d = due date, t = ticket
    ["a", "o", "d", "t"].forEach(k => {
      const input = tr.querySelector(`#act-${k}-${i}`);
      input.dataset.k = k;
      input.value = row[k] || "";
      input.oninput = () => {
        row[k] = input.value;
        flagAction(tr, row);
        markDirty();
      };
    });

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
  FIELDS.forEach(f => { $("#f-" + f).value = state.fields[f] ?? ""; });
  if (!typeSel.value) typeSel.value = "general";
  showTip();
  showFollows();
  showAgendaSum();
  renderPhases();
  renderActions();
  setStatus();
  highlight();
}

/* ---- Sidebar: meeting list ---- */

async function loadList() {
  const q = $("#search").value.trim();
  const list = $("#list");
  try {
    const items = await api("GET", "/api/meetings" + (q ? "?q=" + encodeURIComponent(q) : ""));
    list.innerHTML = "";
    if (!items || !items.length) {
      const msg = q ? "No meetings match that search." : "No saved meetings yet. Fill in the run sheet and press Save.";
      list.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    items.forEach(m => {
      knownMeetings[m.id] = m;
      list.appendChild(listItem(m));
    });
    highlight();
    showFollows();
  } catch (e) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Can't reach the server. Is the PowerShell window still running? (" + e.message + ")";
    list.innerHTML = "";
    list.appendChild(d);
  }
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
  meta.textContent = [m.date, typeName(m.type)].filter(Boolean).join(" \u00b7 ");
  const pill = (text, cls) => {
    const p = document.createElement("span");
    p.className = "pill " + cls;
    p.textContent = text;
    meta.appendChild(p);
  };
  if (m.openActions > 0) pill(m.openActions + " open", "open");
  if (m.overdueActions > 0) pill(m.overdueActions + " overdue", "overdue");

  b.append(title, meta);
  b.onclick = () => guard(() => openMeeting(m.id));
  return b;
}

function highlight() {
  document.querySelectorAll(".item").forEach(b => b.classList.toggle("active", b.dataset.id === state.id));
}

/* ---- Commands: open, save, new, follow-up, delete ---- */

async function openMeeting(id) {
  try {
    const m = await api("GET", "/api/meetings/" + encodeURIComponent(id));
    const actions = (m.actions && m.actions.length) ? m.actions : [blankAction()];
    actions.forEach(a => { if (!a.id) a.id = newActionId(); });   // files from before v1.2.0
    state = {
      id: m.id || id,
      savedAt: m.savedAt,
      follows: m.follows || null,
      fields: m.fields || {},
      checks: migrateChecks(m.checks),
      actions,
    };
    dirty = false;
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
    actions: state.actions.filter(a => a.a || a.o || a.d || a.t),   // drop empty rows
    follows: state.follows || undefined,
  };
  try {
    const m = state.id
      ? await api("PUT", "/api/meetings/" + state.id, body)
      : await api("POST", "/api/meetings", body);
    state.id = m.id;
    state.savedAt = m.savedAt;
    dirty = false;
    setStatus();
    toast("Saved");
    loadList();
  } catch (e) {
    toast("Save failed: " + e.message);
  }
}

function newMeeting() {
  state = blank();
  dirty = false;
  renderAll();
  $("#f-title").focus();
}

// New unsaved meeting with the same brief, today's date and the open actions carried over.
// When it's saved, the server marks those actions "carried" in this meeting (see MeetingStore.psm1).
function followUp() {
  const fields = { date: today() };
  FOLLOW_UP_FIELDS.forEach(k => { if (state.fields[k]) fields[k] = state.fields[k]; });
  const open = state.actions.filter(a => a.a && !a.done && !a.carried).map(a => Object.assign({}, a));
  state = { id: null, follows: state.id, fields, checks: {}, actions: open.length ? open : [blankAction()] };
  dirty = true;
  renderAll();
  toast(open.length ? `Carried over ${open.length} open action${open.length > 1 ? "s" : ""}` : "Brief copied to a new meeting");
}

async function deleteMeeting() {
  try {
    await api("DELETE", "/api/meetings/" + state.id);
    state = blank();
    dirty = false;
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

/* ---- Copy notes (plain-text summary for Slack or email) ---- */

function notes() {
  const f = state.fields;
  const lines = s => (s || "").split("\n").map(x => x.trim()).filter(Boolean);
  const bullets = arr => arr.map(x => "- " + x).join("\n");

  let o = `${f.title || "Meeting notes"}\n`;
  o += [f.date, typeName(f.type), f.length ? f.length + " min" : ""].filter(Boolean).join(" \u00b7 ") + "\n\n";
  if (f.goal) o += `Goal: ${f.goal}\n`;
  if (f.decider) o += `Decision owner: ${f.decider}\n`;
  if (f.attendees) o += `Attendees: ${f.attendees}\n`;

  const decisions = lines(f.decisions);
  o += `\nDECISIONS\n${decisions.length ? bullets(decisions) : "- None recorded"}\n`;

  const acts = state.actions.filter(a => a.a && a.a.trim());
  const actText = a => `${a.done ? "[done] " : a.carried ? "[carried to follow-up] " : ""}${a.a} (Owner: ${a.o || "UNASSIGNED"}, Due: ${a.d || "TBD"}${a.t ? ", " + a.t : ""})`;
  o += `\nACTIONS\n${acts.length ? bullets(acts.map(actText)) : "- None"}\n`;

  const parking = lines(f.parking);
  if (parking.length) o += `\nPARKING LOT\n${bullets(parking)}\n`;
  return o;
}

function copyNotes() {
  const txt = notes();
  const box = $("#fallbackBox");
  const area = $("#copyFallback");
  const fallback = () => {
    area.value = txt;
    box.hidden = false;
    area.select();
  };
  box.hidden = true;
  try {
    navigator.clipboard.writeText(txt).then(() => toast("Notes copied. Paste them into Slack or email."), fallback);
  } catch (e) {
    fallback();
  }
}

/* ---- Help tooltips ---- */

// Turns each <label data-help="..."> into the label plus a (?) button with a tooltip.
// The tip shows while hovering the button; a click (or tap) pins it open until Escape or a click elsewhere.
// The field's input is described by the tip, so screen readers read it on focus.
function setupHelp() {
  document.querySelectorAll("label[data-help]").forEach(label => {
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
    tip.id = "help-" + label.htmlFor;
    tip.setAttribute("role", "tooltip");
    tip.textContent = label.dataset.help;

    row.append(label, btn, tip);
    document.getElementById(label.htmlFor).setAttribute("aria-describedby", tip.id);

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

/* ---- Wire up events and start ---- */

FIELDS.forEach(f => {
  const el = $("#f-" + f);
  el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
    state.fields[f] = el.value;
    markDirty();
    if (f === "type") showTip();
    if (f === "agenda" || f === "length") showAgendaSum();
  });
});

$("#confirmNo").onclick = () => {
  $("#confirmBox").hidden = true;
  pending = null;
};
$("#confirmYes").onclick = () => {
  $("#confirmBox").hidden = true;
  const fn = pending;
  pending = null;
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
$("#copyBtn").onclick = copyNotes;

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
fillTypeOptions();
renderAll();
loadList();
