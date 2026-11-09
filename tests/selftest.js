/*
  Interaction checks for the page, run by tests\Run-Tests.ps1 in headless Edge.
  Not part of the app: the tests copy the page to a temp folder, add this file to it and open
  "/#selftest". It uses the page the way a person does (types, presses Enter, clicks), then writes
  one "PASS name" or "FAIL name" line per check into <pre id="selftest">, which the tests read.
  Names must stay free of & < > and quotes, because they are read back out of the page's HTML.
*/
(async () => {
  if (location.hash !== "#selftest") return;
  const out = [];
  const check = (name, ok) => out.push((ok ? "PASS " : "FAIL ") + name);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const type = (box, text) => { box.value = text; box.dispatchEvent(new Event("input", { bubbles: true })); };
  const enter = box => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const row = i => $("#agendaRows").rows[i];
  const saved = async id => api("GET", "/api/meetings/" + id);

  try {
    await wait(300);   // the first list load and settings sync
    newMeeting();
    type($("#f-title"), "Self test");
    type($("#f-goal"), "a decision");
    type($("#f-length"), "30");

    // Plan: attendees and agenda, typed with Enter between rows.
    type($("#att-0"), "Ana");
    enter($("#att-0"));
    check("Enter adds an attendee row", !!$("#att-1") && document.activeElement === $("#att-1"));
    type($("#att-1"), "Bo");
    type($("#ag-t-0"), "First item");
    type($("#ag-m-0"), "10");
    enter($("#ag-t-0"));
    check("Enter adds an agenda row", !!$("#ag-t-1"));
    type($("#ag-t-1"), "Second item");
    check("typing marks the meeting unsaved", dirty && $("#status").textContent === "Unsaved changes");
    check("readiness strip follows the brief", $("#rGoal").classList.contains("ok") && $("#rAgenda").textContent.includes("has items without minutes"));

    // Run: a decision and an action on the first item, the second left open.
    setPhase("run");
    row(0).querySelector(".rec-toggle").click();
    check("Notes opens the item record", !row(0).querySelector(".rec").hidden);
    type($("#ag-d-0"), "Ship it");
    type($("#ag-n-0-0"), "Risk is low");
    enter($("#ag-n-0-0"));
    check("Enter adds another note to the item", !!$("#ag-n-0-1") && document.activeElement === $("#ag-n-0-1"));
    type($("#ag-n-0-1"), "QA signed off");
    row(0).querySelector(".rec-acts > button").click();
    const line = row(0).querySelector(".act-line");
    type(line.querySelector("textarea"), "Write it up");
    const chips = [...line.querySelectorAll(".who-chip")];
    check("an action without an owner offers the attendees", !line.querySelector(".who-chips").hidden && chips.map(c => c.textContent).join() === "Ana,Bo"
      && line.querySelector("input").classList.contains("missing"));
    chips[1].click();
    check("a click on a name sets the owner", line.querySelector("input").value === "Bo" && line.querySelector(".who-chips").hidden
      && !line.querySelector("input").classList.contains("missing"));
    row(1).querySelector(".rec-toggle").click();
    $("#ag-o-1").click();
    check("an item can be marked left open", state.agenda[1].nd === true);
    type($("#dec-0"), "Move the playtest");
    type($("#park-0"), "Remapping");
    enter($("#park-0"));
    check("Enter adds a parking lot row", !!$("#park-1"));

    // Save and reopen.
    await save();
    const id = state.id;
    check("Save gives the meeting an id and clears the unsaved mark", !!id && !dirty && $("#status").textContent.startsWith("Saved "));
    await openMeeting(id);
    const act = state.actions.find(a => a.a === "Write it up");
    check("a reopened meeting has what was typed", state.fields.title === "Self test" && state.attendees.join() === "Ana,Bo"
      && state.agenda.length === 2 && state.agenda[0].d === "Ship it" && state.agenda[0].m === 10 && state.agenda[1].nd === true
      && state.agenda[0].n === "Risk is low\nQA signed off"
      && !!act && act.o === "Bo" && act.g === state.agenda[0].id
      && state.fields.decisions === "Move the playtest" && state.fields.parking === "Remapping");
    check("an action is saved as text and owner only", !!act && !("d" in act) && !("t" in act) && !("done" in act));

    // Wrap up: the summary and the notes.
    setPhase("wrap");
    const sum = $("#summary").textContent;
    check("the summary shows decisions, left open items and owners", sum.includes("Ship it") && sum.includes("Left open") && sum.includes("Write it up")
      && sum.includes("Bo") && sum.includes("Other decisions") && sum.includes("Move the playtest") && sum.includes("Remapping"));
    check("the print heading names the meeting", $("#printHead").textContent.includes("Self test") && $("#printHead").textContent.includes("Ana, Bo"));
    const text = notes(false);
    const at = s => text.indexOf(s);
    check("Copy notes goes item by item: decision then action, then the next item", at("1. First item (10 min)") >= 0
      && at("1. First item") < at("Decision: Ship it") && at("Decision: Ship it") < at("Write it up (Owner: Bo)")
      && at("Write it up (Owner: Bo)") < at("2. Second item") && at("2. Second item") < at("Left open")
      && at("Left open") < at("Other decisions") && at("Move the playtest") > at("Other decisions") && !text.includes("Due:"));
    const html = notes("html");
    check("Copy notes as HTML has a heading per item and bullet lists", html.includes("<h3>1. First item (10 min)</h3>")
      && html.includes("<li>Write it up (Owner: Bo)</li>") && html.includes("<b>Decision:</b> Ship it"));

    // Removing an agenda item leaves its action under "Actions with no agenda item", still editable.
    setPhase("run");
    check("no loose actions block while every action has an item", $("#looseActs").hidden);
    row(0).querySelector("td.x button").click();
    const loose = $("#looseActList").querySelector(".act-line textarea");
    check("an action whose item was removed stays editable", !$("#looseActs").hidden && !!loose && loose.value === "Write it up" && !loose.readOnly);
    await openMeeting(id);   // throw that change away

    // Saving over a version that was saved somewhere else.
    await api("PUT", "/api/meetings/" + id, { fields: { title: "Changed elsewhere", date: state.fields.date }, checks: {}, actions: [] });
    type($("#f-title"), "Mine");
    await save();
    check("a save over a newer version is refused and asks", !$("#confirmBox").hidden && dirty && (await saved(id)).fields.title === "Changed elsewhere");
    $("#confirmYes").click();
    await wait(400);
    check("Overwrite then saves it", !dirty && (await saved(id)).fields.title === "Mine" && (await saved(id)).agenda.length === 2);

    // Autosave: in Run, a change to a saved meeting is saved without pressing Save.
    type($("#park-0"), "Remapping");
    check("a change outside Run plans no autosave", dirty && autoTimer === null);
    setPhase("run");
    type($("#park-0"), "Remapping, autosaved");
    check("a change in Run plans an autosave", dirty && autoTimer !== null);
    await autosave();
    check("autosave saves without being asked", !dirty && autoTimer === null && $("#confirmBox").hidden
      && (await saved(id)).fields.parking === "Remapping, autosaved");
    await api("PUT", "/api/meetings/" + id, Object.assign(await saved(id), { savedAt: undefined }));
    type($("#park-0"), "Remapping, again");
    await autosave();
    check("an autosave over a newer version pauses and does not ask", dirty && autoOff && $("#confirmBox").hidden
      && (await saved(id)).fields.parking === "Remapping, autosaved");
    await save(true);
    check("Save after that turns autosave back on", !dirty && !autoOff && (await saved(id)).fields.parking === "Remapping, again");

    // Timer: stays on its item when the agenda changes while the meeting runs.
    $("#timerBtn").click();
    $("#tNext").click();
    check("the timer marks the item it is on", row(1).classList.contains("now") && row(0).classList.contains("past") && $("#tLabel").textContent === "Now 2/2"
      && $("#tNext").textContent === "Wrap up");
    $("#addAgenda").click();
    type($("#ag-t-2"), "Late addition");
    check("an item added mid-meeting joins the timer", row(1).classList.contains("now") && $("#tLabel").textContent === "Now 2/3"
      && $("#tNext").textContent === "Next item" && $("#tSegs").children.length === 3);
    row(1).querySelector('[data-mv="-1"]').click();
    check("moving the current item moves the timer with it", row(0).classList.contains("now") && $("#tLabel").textContent === "Now 1/3" && $("#tItem").textContent === "Second item");
    row(1).querySelector("td.x button").click();
    check("removing another item keeps the timer on the current one", row(0).classList.contains("now") && $("#tLabel").textContent === "Now 1/2" && $("#tItem").textContent === "Second item");
    type($("#ag-t-0"), "Second item, renamed");
    check("the timer shows a renamed item", $("#tItem").textContent === "Second item, renamed");
    $("#tStop").click();
    await openMeeting(id);   // throw those changes away

    // Follow-up: the brief and agenda, no actions, and what came out of last time.
    followUp();
    await wait(400);
    check("a follow-up copies the brief, agenda and attendees but no actions", state.follows === id && !state.id && state.fields.title === "Mine"
      && state.agenda.length === 2 && !state.agenda[0].d && state.attendees.join() === "Ana,Bo" && state.actions.every(a => !a.a));
    const last = $("#lastBody").textContent;
    check("a follow-up shows what came out of last time", !$("#lastTime").hidden && last.includes("First item: Ship it") && last.includes("Second item")
      && last.includes("Write it up") && last.includes("Bo"));

    // Repeat weekly.
    $("#repeatBtn").click();
    check("Repeat weekly asks for a saved meeting first", $("#repeatBox").hidden);
    await openMeeting(id);
    check("a meeting that follows nothing has no Last time card", $("#lastTime").hidden);
    $("#repeatBtn").click();
    check("Repeat weekly opens its box", !$("#repeatBox").hidden);
    type($("#repeatCount"), "2");
    $("#repeatGo").click();
    await wait(1500);
    const [y, mo, d] = state.fields.date.split("-").map(Number);
    const copies = (await api("GET", "/api/meetings")).filter(m => m.title === "Mine" && m.id !== id);
    check("Repeat weekly plans one copy a week", copies.length === 2
      && copies.map(m => m.date).sort().join() === [7, 14].map(n => isoDay(new Date(y, mo - 1, d + n))).join()
      && copies.every(m => m.agendaCount === 2));
    check("the repeated meetings share a series with the first one", state.series === id && (await saved(id)).series === id
      && copies.every(m => m.series === id));
    const series = $("#seriesLine");
    check("the brief shows the place in the series and the next meeting", !series.hidden && series.textContent.includes("1 of 3")
      && series.textContent.includes("Next: " + isoDay(new Date(y, mo - 1, d + 7))) && !series.textContent.includes("Previous"));
    $("#repeatBtn").click();
    type($("#repeatCount"), "3");
    $("#repeatGo").click();
    await wait(1500);
    const all = (await api("GET", "/api/meetings")).filter(m => m.series === id);
    check("repeating again only plans the weeks that have no meeting yet", all.length === 4
      && all.map(m => m.date).sort().join() === [0, 7, 14, 21].map(n => isoDay(new Date(y, mo - 1, d + n))).join());

    // Settings follow the sidebar and theme choices.
    $("#sideBtn").click();
    [...document.querySelectorAll("#themeList button")].find(b => b.dataset.theme === "dark").click();
    await wait(300);
    const s = await api("GET", "/api/settings");
    check("the sidebar and theme choices are stored with the meetings", s.sideOff === true && s.theme === "dark" && document.documentElement.dataset.theme === "dark");

    // Delete.
    await deleteMeeting();
    check("a deleted meeting leaves the list", !state.id && !(await api("GET", "/api/meetings")).some(m => m.id === id));

    // Deleted meetings and backups: put it back.
    $("#binBtn").click();
    await wait(500);
    const back = [...document.querySelectorAll("#binDeleted .bin-row")].find(r => r.textContent.includes("Mine"));
    check("a deleted meeting is listed with a Put back button", !$("#binBox").hidden && !!back && back.querySelector("button").textContent === "Put back");
    check("the startup backup is listed", document.querySelectorAll("#binBackups .bin-row").length === 1);
    back.querySelector("button").click();
    await wait(800);
    check("Put back returns the meeting as it was", (await saved(id)).fields.parking === "Remapping, again"
      && !document.querySelector("#binDeleted .bin-row") && ["up", "past"].some(t => { setListTab(t); return !!document.querySelector(`#list .item[data-id="${id}"]`); }));

    // Sidebar tabs: a past meeting shows on Past under its month with what came out of it.
    await api("POST", "/api/meetings", { fields: { title: "Old review", date: "2020-01-15", goalmet: "yes" },
      agenda: [{ t: "Scope", m: 10, d: "Keep it small" }], actions: [{ id: "x1", a: "Write it down", o: "Ana" }] });
    await loadList();
    setListTab("up");
    check("Upcoming shows no months", !document.querySelector("#list .month"));
    setListTab("past");
    const jan = [...document.querySelectorAll("#list .month")].find(b => b.textContent.startsWith("January 2020"));
    check("Past lists meetings by month and keeps the calendar", !!jan && getComputedStyle($("#calGrid")).display !== "none");
    if (jan.getAttribute("aria-expanded") !== "true") jan.click();
    const old = [...document.querySelectorAll("#list .item")].find(b => b.textContent.includes("Old review"));
    check("a past meeting shows its decisions, actions and goal", !!old && old.textContent.includes("1 decision") && old.textContent.includes("1 action") && old.textContent.includes("Goal met"));
    [...document.querySelectorAll("#list .month")].find(b => b.textContent.startsWith("January 2020")).click();
    check("a month folds", ![...document.querySelectorAll("#list .item")].some(b => b.textContent.includes("Old review")));
    setListTab("up");

    // Last: the mock meeting (tests\mock-meeting.json, copied next to the page). Its notes go into
    // <pre id="mocknotes"> and the tests print them, so the export can be read after every run.
    const mock = await (await fetch("mock-meeting.json")).json();
    const made = await api("POST", "/api/meetings", mock);
    await openMeeting(made.id);
    const mn = notes(false);
    const pos = s => mn.indexOf(s);
    const heads = [1, 2, 3, 4].map(n => pos(`\n${n}. `));
    check("mock meeting opens with 4 agenda items and 8 actions", state.agenda.length === 4 && state.actions.length === 8);
    check("mock notes list the 4 items in order", heads.every(p => p > 0) && heads.every((p, i) => !i || p > heads[i - 1]));
    check("mock notes keep each item notes and action points under that item", pos("Repro rate") > heads[0] && pos("Bisect the asset bundle") < heads[1]
      && pos("Cert risk") > heads[1] && pos("Tell marketing") < heads[2] && pos("Four of twelve") > heads[2]
      && pos("Draft two options") < heads[3] && pos("Send cinematics timing") > heads[3]);
    check("mock notes flag the unassigned action and list the loose one last", mn.includes("presets are must-have (Owner: UNASSIGNED)")
      && pos("Action points with no agenda item") > heads[3] && pos("Book the build farm review") > pos("Action points with no agenda item")
      && pos("Parking lot") > pos("Book the build farm review"));
    const mh = notes("html");
    check("mock notes as HTML have 4 item headings", (mh.match(/<h3>\d\. /g) || []).length === 4);
    const mp = document.createElement("pre");
    mp.id = "mocknotes";
    mp.textContent = mn;
    document.body.append(mp);
  } catch (e) {
    out.push("FAIL selftest stopped early: " + String(e && e.message).replace(/[&<>"']/g, " "));
  }
  const pre = document.createElement("pre");
  pre.id = "selftest";
  pre.textContent = out.join("\n");
  document.body.append(pre);
})();
