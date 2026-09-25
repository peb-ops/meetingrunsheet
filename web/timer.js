/*
  Meeting timer: a sticky bar that runs the agenda against the clock.
  Uses $, state and parseAgenda() from app.js. Nothing here is saved to the meeting file.

  The agenda is read once when you press Start meeting. Each item counts down its minutes;
  the clock turns amber near the end (5 min left, or 1 min for items under 10 min) and red
  when the item runs over. The browser tab title shows the time left, so you can see it
  while sharing another window.
*/

const PAGE_TITLE = document.title;
const timer = { items: [], index: 0, start: 0, itemStart: 0, totalMin: 0, tick: null };

// Seconds as "m:ss".
function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}

function startTimer() {
  const timebox = +state.fields.length || 0;
  let items = parseAgenda(state.fields.agenda);
  if (!items.length) items = [{ title: state.fields.title || "Meeting", min: timebox || null }];

  const now = Date.now();
  Object.assign(timer, {
    items,
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

function nextItem() {
  if (timer.index >= timer.items.length - 1) return;
  timer.index++;
  timer.itemStart = Date.now();
  renderTimer();
}

function renderTimer() {
  const now = Date.now();
  const item = timer.items[timer.index];
  const itemSec = (now - timer.itemStart) / 1000;
  const meetingSec = (now - timer.start) / 1000;

  let itemText, level = "";
  if (item.min) {
    const left = item.min * 60 - itemSec;
    const warnAt = item.min >= 10 ? 300 : 60;
    itemText = left >= 0 ? clock(left) + " left" : clock(-left) + " over";
    level = left < 0 ? "over" : left <= warnAt ? "warn" : "";
  } else {
    itemText = clock(itemSec) + " so far";
  }

  const bar = $("#timerBar");
  bar.classList.toggle("warn", level === "warn");
  bar.classList.toggle("over", level === "over");
  $("#tItemNo").textContent = `${timer.index + 1}/${timer.items.length}`;
  $("#tItem").textContent = item.title;
  $("#tItemLeft").textContent = itemText;

  const total = $("#tTotal");
  total.textContent = timer.totalMin ? `${clock(meetingSec)} / ${clock(timer.totalMin * 60)}` : clock(meetingSec);
  total.classList.toggle("over", !!timer.totalMin && meetingSec > timer.totalMin * 60);

  const last = timer.index === timer.items.length - 1;
  $("#tNext").disabled = last;
  $("#tNext").textContent = last ? "Last item" : "Next item";
  document.title = `${itemText} \u00b7 ${item.title}`;
}

$("#timerBtn").onclick = startTimer;
$("#tNext").onclick = nextItem;
$("#tStop").onclick = stopTimer;
