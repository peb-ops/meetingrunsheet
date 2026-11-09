// Meeting Run Sheet - theme and page settings. Loaded in <head>, before the page is drawn, so a
// chosen theme never flashes the other one first and switched-off parts never show for a moment.
// The Settings page that changes them is setupSettings() in app.js.

// [key, name, swatch colours (background, surface, accent) for the Settings page], in order.
// "" follows the system setting (the media query in styles.css); every other key has a block of
// colours there under :root[data-theme="<key>"]. Keep the swatches in step with those blocks.
const THEMES = [
  ["", "System", ["#F5F6F8", "#171A20", "#4F46E5"]],
  ["light", "Light", ["#F5F6F8", "#FFFFFF", "#4F46E5"]],
  ["dark", "Dark", ["#0F1115", "#171A20", "#8B85FF"]],
  ["paper", "Paper", ["#F4EFE6", "#FBF8F1", "#17695F"]],
  ["sky", "Sky", ["#EAF2FB", "#FFFFFF", "#0B6BCB"]],
  ["midnight", "Midnight", ["#0A1020", "#111A2E", "#38BDF8"]],
  ["forest", "Forest", ["#0D1411", "#141D18", "#5FD08A"]]
];

// Kept in this browser (localStorage) and mirrored to the server (pushSettings in app.js).
const THEME_KEY = "runsheet-theme";

let themeChoice = "";
try { themeChoice = localStorage.getItem(THEME_KEY) || ""; } catch (e) {}
if (!THEMES.some(t => t[0] === themeChoice)) themeChoice = "";

// styles.css picks its colours from <html data-theme>.
function applyTheme() {
  if (themeChoice) document.documentElement.dataset.theme = themeChoice;
  else delete document.documentElement.dataset.theme;
}

// Parts of the page that can be switched off on the Settings page. All on unless switched off.
//   timebox    minutes per agenda item, the timebox, start times and timebox checks
//   autosave   autosave in Run
//   checklist  the facilitation checklist and the Prep check
//   nav        the floating Sections button
// Off shows as a class on <html> (no-timebox, no-checklist, no-nav); styles.css hides those parts.
const PREFS_KEY = "runsheet-prefs";
const PREF_KEYS = ["timebox", "autosave", "checklist", "nav"];
const prefs = { timebox: true, autosave: true, checklist: true, nav: true };
try {
  const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  PREF_KEYS.forEach(k => { if (typeof stored[k] === "boolean") prefs[k] = stored[k]; });
} catch (e) {}

function applyPrefs() {
  const c = document.documentElement.classList;
  c.toggle("no-timebox", !prefs.timebox);
  c.toggle("no-checklist", !prefs.checklist);
  c.toggle("no-nav", !prefs.nav);
}

applyTheme();
applyPrefs();
