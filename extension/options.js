/* Saved on change rather than behind a Save button: two settings, both instantly reversible, and a
   popup that closes the moment you click away — a Save button here is a way to lose an edit. */

const DEFAULTS = { baseUrl: "http://localhost:8080", enabled: true };

const base = document.getElementById("base");
const enabled = document.getElementById("enabled");
const saved = document.getElementById("saved");

let acknowledge;

function acknowledged(text) {
  saved.textContent = text;
  saved.classList.add("on");
  clearTimeout(acknowledge);
  acknowledge = setTimeout(() => saved.classList.remove("on"), 1600);
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  base.value = s.baseUrl ?? DEFAULTS.baseUrl;
  enabled.checked = s.enabled !== false;
});

base.addEventListener("change", () => {
  const value = base.value.trim().replace(/\/+$/, "");
  // An address that isn't one would produce a link that goes nowhere. Better to say so and keep the
  // last good value than to accept it silently.
  if (value && !/^https?:\/\/[^\s/]+/i.test(value)) {
    acknowledged("That doesn't look like a URL — not saved.");
    return;
  }
  chrome.storage.sync.set({ baseUrl: value }).then(() => acknowledged(value ? "Saved." : "Cleared — no link is offered."));
});

enabled.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabled.checked })
    .then(() => acknowledged(enabled.checked ? "On." : "Off — nothing is added to the page."));
});
