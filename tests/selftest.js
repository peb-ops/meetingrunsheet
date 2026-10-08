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
    check("Copy notes has decisions, the left open item and the action", text.includes("First item: Ship it") && text.includes("Second item: left open")
      && text.includes("Move the playtest") && text.includes("Write it up (Owner: Bo)") && !text.includes("Due:"));

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
    await wait(800);
    const [y, mo, d] = state.fields.date.split("-").map(Number);
    const copies = (await api("GET", "/api/meetings")).filter(m => m.title === "Mine" && m.id !== id);
    check("Repeat weekly plans one copy a week", copies.length === 2
      && copies.map(m => m.date).sort().join() === [7, 14].map(n => isoDay(new Date(y, mo - 1, d + n))).join()
      && copies.every(m => m.agendaCount === 2));

    // Settings follow the sidebar and theme choices.
    $("#sideBtn").click();
    [...document.querySelectorAll("#themeList button")].find(b => b.dataset.theme === "dark").click();
    await wait(300);
    const s = await api("GET", "/api/settings");
    check("the sidebar and theme choices are stored with the meetings", s.sideOff === true && s.theme === "dark" && document.documentElement.dataset.theme === "dark");

    // Delete.
    await deleteMeeting();
    check("a deleted meeting leaves the list", !state.id && !(await api("GET", "/api/meetings")).some(m => m.id === id));
  } catch (e) {
    out.push("FAIL selftest stopped early: " + String(e && e.message).replace(/[&<>"']/g, " "));
  }
  const pre = document.createElement("pre");
  pre.id = "selftest";
  pre.textContent = out.join("\n");
  document.body.append(pre);
})();
