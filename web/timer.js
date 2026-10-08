/*
  Meeting timer: a sticky bar that runs the agenda against the clock.
  Uses $, state, agendaItems(), agendaFilled(), setRecord() and setPhase() from app.js, and WRAP_UP
  from content.js. Start meeting moves the sheet to Run, and Wrap up moves it to Wrap up.
  Nothing here is saved to the meeting file.

  A running timer survives a page reload: it is kept in localStorage ("runsheet-timer") with the
  id of its meeting. After a reload the page reopens that meeting and the bar carries on where it
  was (an unsaved meeting resumes when its draft is restored). Stop clears it; one older than
  12 hours is dropped.

  The agenda is read once when you press Start meeting. Each item counts down its minutes;
  the clock turns amber near the end (5 min left, or 1 min for items under 10 min) and red
  when the item runs over. Next item moves on; on the last item the button becomes Wrap up,
  which shows the closing reminder and the meeting's remaining time.
  With no agenda, the bar just counts down the timebox and has no Next / Wrap up button.
  The browser tab title shows the time left, so you can see it while sharing another window.
*/

const PAGE_TITLE = document.title;
const timer = { meeting: "", items: [], hasAgenda: false, wrapUp: false, index: 0, start: 0, itemStart: 0, totalMin: 0, tick: null };
const TIMER_KEY = "runsheet-timer";
const TIMER_MAX_AGE = 12 * 3600 * 1000;
const UNSAVED = "unsaved";   // stands in for the id of a meeting that hasn't been saved yet

// Seconds as "m:ss".
function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}

// "4:12 left" or "1:05 over", with a level for the bar colour.
function countdown(secLeft, warnAt) {
  return {
    text: secLeft >= 0 ? clock(secLeft) + " left" : clock(-secLeft) + " over",
    level: secLeft < 0 ? "over" : secLeft <= warnAt ? "warn" : "",
  };
}

function startTimer() {
  const timebox = +state.fields.length || 0;
  const agenda = agendaItems();
  const items = agenda.length ? agenda : [{ title: state.fields.title || "Meeting", min: timebox || null }];

  const now = Date.now();
  Object.assign(timer, {
    meeting: state.id || UNSAVED,
    items,
    hasAgenda: agenda.length > 0,
    wrapUp: false,
    index: 0,
    start: now,
    itemStart: now,
    totalMin: timebox || items.reduce((sum, it) => sum + (it.min || 0), 0),
  });
  showTimer();
}

function showTimer() {
  $("#timerBar").hidden = false;
  $("#timerBtn").hidden = true;
  clearInterval(timer.tick);
  timer.tick = setInterval(renderTimer, 1000);
  renderTimer();
  storeTimer();
  setPhase(timer.wrapUp ? "wrap" : "run");
  markAgendaNow();
  openNowRecord();
}

function stopTimer() {
  clearInterval(timer.tick);
  timer.tick = null;
  markAgendaNow();
  $("#timerBar").hidden = true;
  $("#timerBtn").hidden = false;
  document.title = PAGE_TITLE;
  try { localStorage.removeItem(TIMER_KEY); } catch (e) {}
}

/* ---- Keeping the timer across a reload ---- */

function storeTimer() {
  const { meeting, items, hasAgenda, wrapUp, index, start, itemStart, totalMin } = timer;
  try { localStorage.setItem(TIMER_KEY, JSON.stringify({ meeting, items, hasAgenda, wrapUp, index, start, itemStart, totalMin })); } catch (e) {}
}

// The stored timer, or null if there is none or it is too old to be the same meeting.
function storedTimer() {
  let t = null;
  try { t = JSON.parse(localStorage.getItem(TIMER_KEY) || "null"); } catch (e) {}
  if (!t || !t.meeting || !Array.isArray(t.items) || !t.items.length || !(Date.now() - t.start < TIMER_MAX_AGE)) return null;
  return t;
}

// Picks up the stored timer if it belongs to this meeting (a saved id, or UNSAVED after a draft
// restore). Called by renderAll() and offerDraft() in app.js. Does nothing while a timer is running.
function resumeTimer(meeting) {
  if (timer.tick || !meeting) return;
  const t = storedTimer();
  if (!t || t.meeting !== meeting) return;
  Object.assign(timer, t);
  showTimer();
}

// A meeting that was unsaved when its timer started has just been saved and got an id.
function timerMeetingSaved(id) {
  if (timer.tick && timer.meeting === UNSAVED) {
    timer.meeting = id;
    storeTimer();
  }
}

// Next item, or Wrap up after the last one.
function nextItem() {
  // The item being left closes its record (its decision stays in view under the title).
  const done = timerRows()[timer.index];
  if (done) setRecord(done, false);
  if (timer.index < timer.items.length - 1) {
    timer.index++;
    timer.itemStart = Date.now();
  } else {
    timer.wrapUp = true;
    setPhase("wrap");   // decisions and actions, ready to read back
    window.scrollTo(0, 0);
  }
  renderTimer();
  storeTimer();
  markAgendaNow();
  openNowRecord();
}

// Shows where the meeting is in the agenda card: the current item gets the class "now", finished
// ones "past". Rows are matched to the timer's items by position, so nothing is marked once the
// agenda has a different number of filled-in rows than when the timer started.
// Also called by showAgendaTimes() in app.js whenever the agenda is redrawn or edited.
function markAgendaNow() {
  const rows = timerRows();
  state.agenda.forEach((row, i) => {
    const tr = $("#agendaRows").rows[i];
    if (!tr) return;
    const at = rows.indexOf(row);
    tr.classList.toggle("now", at === timer.index && !timer.wrapUp);
    tr.classList.toggle("past", at >= 0 && (at < timer.index || timer.wrapUp));
  });
}

// The agenda rows the timer's items stand for, in order; none if the timer isn't running on the
// meeting on screen, or its agenda no longer has the same number of filled-in rows.
function timerRows() {
  const rows = state.agenda.filter(agendaFilled);
  const on = !!timer.tick && timer.hasAgenda && timer.meeting === (state.id || UNSAVED) && rows.length === timer.items.length;
  return on ? rows : [];
}

// Opens the current item's record (decision + notes), so there is somewhere to type as it is discussed.
function openNowRecord() {
  const row = timerRows()[timer.index];
  if (row && !timer.wrapUp) setRecord(row, true);
}

function renderTimer() {
  const now = Date.now();
  const meetingSec = (now - timer.start) / 1000;
  const item = timer.items[timer.index];
  const itemSec = (now - timer.itemStart) / 1000;
  let label, title, time = { text: "", level: "" };

  if (timer.wrapUp) {
    label = "Wrap up";
    title = WRAP_UP;
    time = timer.totalMin ? countdown(timer.totalMin * 60 - meetingSec, -1) : { text: clock(meetingSec) + " so far", level: "" };
  } else {
    label = timer.hasAgenda ? `Now ${timer.index + 1}/${timer.items.length}` : "Now";
    title = item.title;
    time = item.min ? countdown(item.min * 60 - itemSec, item.min >= 10 ? 300 : 60) : { text: clock(itemSec) + " so far", level: "" };
  }

  const bar = $("#timerBar");
  bar.classList.toggle("warn", time.level === "warn");
  bar.classList.toggle("over", time.level === "over");
  $("#tLabel").textContent = label;
  $("#tItem").textContent = title;
  $("#tItemLeft").textContent = time.text;

  const total = $("#tTotal");
  total.textContent = timer.totalMin ? `${clock(meetingSec)} / ${clock(timer.totalMin * 60)}` : clock(meetingSec);
  total.classList.toggle("over", !!timer.totalMin && meetingSec > timer.totalMin * 60);

  // Against the plan: how late (or early) the current item started, if the items before it have minutes.
  const before = timer.items.slice(0, timer.index);
  const paced = timer.hasAgenda && !timer.wrapUp && before.length > 0 && before.every(it => it.min);
  const late = paced ? Math.round((timer.itemStart - timer.start) / 60000 - before.reduce((sum, it) => sum + it.min, 0)) : 0;
  $("#tPace").textContent = !paced ? "" : late > 0 ? `\u00b7 ${late} min behind plan` : late < 0 ? `\u00b7 ${-late} min ahead of plan` : "\u00b7 on plan";

  // One segment per agenda item, as wide as its minutes: done, the current one filling up, to come.
  const segs = $("#tSegs");
  segs.hidden = !timer.hasAgenda;
  if (timer.hasAgenda) {
    if (segs.children.length !== timer.items.length) {
      segs.replaceChildren(...timer.items.map(it => {
        const seg = document.createElement("i");
        seg.style.flex = `${it.min || 5} 1 0`;
        seg.appendChild(document.createElement("b"));
        return seg;
      }));
    }
    [...segs.children].forEach((seg, k) => {
      const current = k === timer.index && !timer.wrapUp;
      seg.classList.toggle("done", timer.wrapUp || k < timer.index);
      seg.firstChild.style.width = (current ? (item.min ? Math.min(1, itemSec / (item.min * 60)) : 1) * 100 : 0) + "%";
    });
  }

  const next = $("#tNext");
  next.hidden = !timer.hasAgenda || timer.wrapUp;
  next.textContent = timer.index === timer.items.length - 1 ? "Wrap up" : "Next item";
  document.title = `${time.text} \u00b7 ${timer.wrapUp ? "Wrap up" : item.title}`;
}

$("#timerBtn").onclick = startTimer;
$("#tNext").onclick = nextItem;
$("#tStop").onclick = stopTimer;

// After a reload: reopen the meeting whose timer was running (renderAll then resumes it).
// If a draft restore is on offer, leave it to that instead.
(function reopenTimedMeeting() {
  const t = storedTimer();
  if (!t) { try { localStorage.removeItem(TIMER_KEY); } catch (e) {} return; }
  if (t.meeting === state.id) resumeTimer(t.meeting);
  else if (t.meeting !== UNSAVED && $("#confirmBox").hidden) openMeeting(t.meeting);
})();
