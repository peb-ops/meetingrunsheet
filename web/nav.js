/*
  Section nav: a floating list of the page's sections, so you can jump without scrolling.
  Uses $ from app.js and PHASES from content.js. Nothing here is saved.

  Wide windows show the list in the right margin all the time. Narrower windows show a
  Sections button in the bottom-right corner that opens it (Esc or a click elsewhere closes it).
  The section you're in is highlighted. Jumping to a notes box also puts the cursor in it.
*/

// [label, section element, box to focus or null, starts a new group]. Elements are looked up
// on every use, because renderPhases() rebuilds the checklist.
const NAV_TARGETS = [
  ["Brief", () => $("#briefH").closest("section"), null, false],
  ["Agenda", () => $("#agendaRows").closest(".field"), null, false],
  ...PHASES.map((p, i) => [p.name, () => $("#c-" + p.id).closest(".phase"), null, i === 0]),
  ["Decisions", () => $("#f-decisions").closest(".field"), "#f-decisions", true],
  ["Parking lot", () => $("#f-parking").closest(".field"), "#f-parking", false],
  ["Actions", () => $("#actionRows").closest(".full"), null, false],
  ["Self-review", () => $("#f-reflect").closest(".field"), "#f-reflect", false],
];

const nav = $("#jumpNav");
const navToggle = $("#jumpToggle");
const navList = $("#jumpList");
let navPicked = -1;   // last clicked entry; wins over entries at the same height (e.g. side-by-side phases)

// Space the sticky timer bar takes at the top of the window, so a jump doesn't land under it.
function navOffset() {
  const bar = $("#timerBar");
  return bar.hidden ? 12 : bar.offsetHeight + 16;
}

function jumpTo(i) {
  const [, target, focusSel] = NAV_TARGETS[i];
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  // The brief is at the top: go all the way up so the Save / Start meeting toolbar shows too.
  const top = i === 0 ? 0 : target().getBoundingClientRect().top + window.scrollY - navOffset();
  window.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  if (focusSel) $(focusSel).focus({ preventScroll: true });
  navPicked = i;
  setNavOpen(false);
  showCurrent();
}

// Highlight the last section whose top has scrolled past a line a third of the way down.
function showCurrent() {
  const line = navOffset() + window.innerHeight / 3;
  let best = 0, bestTop = -Infinity;
  NAV_TARGETS.forEach(([, target], i) => {
    const top = Math.round(target().getBoundingClientRect().top);
    if (top <= line && (top > bestTop || (top === bestTop && i === navPicked))) { best = i; bestTop = top; }
  });
  navList.querySelectorAll(".jump-link").forEach((b, i) => {
    if (i === best) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
}

function setNavOpen(open) {
  nav.classList.toggle("open", open);
  navToggle.setAttribute("aria-expanded", String(open));
}

NAV_TARGETS.forEach(([label, , , newGroup], i) => {
  const b = document.createElement("button");
  b.className = "jump-link" + (newGroup ? " group" : "");
  b.textContent = label;
  b.onclick = () => jumpTo(i);
  navList.appendChild(b);
});

navToggle.onclick = () => setNavOpen(!nav.classList.contains("open"));
document.addEventListener("keydown", e => { if (e.key === "Escape") setNavOpen(false); });
document.addEventListener("click", e => { if (!nav.contains(e.target)) setNavOpen(false); });
// Scrolling with the wheel or touch clears the "picked" tie-break.
["wheel", "touchmove"].forEach(ev => window.addEventListener(ev, () => { navPicked = -1; }, { passive: true }));

let navFrame = 0;
window.addEventListener("scroll", () => {
  cancelAnimationFrame(navFrame);
  navFrame = requestAnimationFrame(showCurrent);
}, { passive: true });
window.addEventListener("resize", showCurrent);
showCurrent();
