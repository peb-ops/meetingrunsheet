// Meeting Run Sheet - theme choice. Loaded in <head>, before the page is drawn, so a chosen
// theme never flashes the other one first. The menu entry that changes it is setupTheme() in app.js.

// [key, name in the menu], in menu order. "" follows the system setting (the media query in
// styles.css); every other key has a block of colours there under :root[data-theme="<key>"].
const THEMES = [
  ["", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
  ["paper", "Paper"],
  ["sky", "Sky"],
  ["midnight", "Midnight"],
  ["forest", "Forest"]
];

// Kept in this browser only (localStorage).
const THEME_KEY = "runsheet-theme";

let themeChoice = "";
try { themeChoice = localStorage.getItem(THEME_KEY) || ""; } catch (e) {}
if (!THEMES.some(t => t[0] === themeChoice)) themeChoice = "";

// styles.css picks its colours from <html data-theme>.
function applyTheme() {
  if (themeChoice) document.documentElement.dataset.theme = themeChoice;
  else delete document.documentElement.dataset.theme;
}

applyTheme();
