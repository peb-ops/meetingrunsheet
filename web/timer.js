/*
  Meeting timer: a sticky bar that runs the agenda against the clock.
  Uses $, state and agendaItems() from app.js, and WRAP_UP from content.js.
  Nothing here is saved to the meeting file.

  The agenda is read once when you press Start meeting. Each item counts down its minutes;
  the clock turns amber near the end (5 min left, or 1 min for items under 10 min) and red
  when the item runs over. Next item moves on; on the last item the button becomes Wrap up,
  which shows the closing reminder and the meeting's remaining time.
  With no agenda, the bar just counts down the timebox and has no Next / Wrap up button.
  The browser tab title shows the time left, so you can see it while sharing another window.
*/

const PAGE_TITLE = document.title;
const timer = { items: [], hasAgenda: false, wrapUp: false, index: 0, start: 0, itemStart: 0, totalMin: 0, tick: null };

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
    items,
    hasAgenda: agenda.length > 0,
    wrapUp: false,
    index: 0,
    start: now,
    itemStart: now,
    totalMin: timebox || items.reduce((sum, it) => sum + (it.min || 0), 0),
  });
  $("#timerBar").hidden = false;
  $("#timerBtn").hidden = true;
  clearInterval(timer.tick);
  timer.tick = setInterval(renderTimer, 1000);
  renderTimer();
}

function stopTimer() {
  clearInterval(timer.tick);
  timer.tick = null;
  $("#timerBar").hidden = true;
  $("#timerBtn").hidden = false;
  document.title = PAGE_TITLE;
}

// Next item, or Wrap up after the last one.
function nextItem() {
  if (timer.index < timer.items.length - 1) {
    timer.index++;
    timer.itemStart = Date.now();
  } else {
    timer.wrapUp = true;
  }
  renderTimer();
}

function renderTimer() {
  const now = Date.now();
  const meetingSec = (now - timer.start) / 1000;
  const item = timer.items[timer.index];
  let label, title, time = { text: "", level: "" };

  if (timer.wrapUp) {
    label = "Wrap up";
    title = WRAP_UP;
    time = timer.totalMin ? countdown(timer.totalMin * 60 - meetingSec, -1) : { text: clock(meetingSec) + " so far", level: "" };
  } else {
    label = timer.hasAgenda ? `Now ${timer.index + 1}/${timer.items.length}` : "Now";
    title = item.title;
    const itemSec = (now - timer.itemStart) / 1000;
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

  const next = $("#tNext");
  next.hidden = !timer.hasAgenda || timer.wrapUp;
  next.textContent = timer.index === timer.items.length - 1 ? "Wrap up" : "Next item";
  document.title = `${time.text} \u00b7 ${timer.wrapUp ? "Wrap up" : item.title}`;
}

$("#timerBtn").onclick = startTimer;
$("#tNext").onclick = nextItem;
$("#tStop").onclick = stopTimer;
