/*
 * A sticky offer on Azure DevOps pull request pages, rather than a redirect away from them.
 *
 * The earlier version rewrote the URL before the request left the browser, which was the wrong trade
 * even when it worked: a pull request link goes to Azure DevOps because Azure DevOps is where branch
 * policies, work items, approvals and completion live. Deciding on the reviewer's behalf that they
 * meant Launchpad was a guess, and a wrong guess cost them a page load and their place in the diff.
 *
 * So the link lands where it was pointed, and this offers the other door.
 *
 * The redirect's hardest problem disappears with it. Chrome silently skips a `declarativeNetRequest`
 * redirect when the extension has no host access to the request's *initiator*, so a link clicked
 * inside Slack or Jira did nothing while the same URL pasted into the address bar worked — invisibly,
 * with no error anywhere. Nothing is redirected now, so there is no initiator to have access to: this
 * runs on the ADO page itself, which the extension is granted by its own `matches`.
 */

const DEFAULTS = { baseUrl: "http://localhost:8080", enabled: true };

/* The shared matcher, imported rather than restated so the banner and `rules.test.mjs` agree on what a
   pull request URL is. A content script isn't a module, so the import is dynamic and by extension URL,
   which is why rules.js is web-accessible in the manifest. */
const rules = import(chrome.runtime.getURL("rules.js"));

const HOST_ID = "launchpad-pr-offer";

/** The Launchpad address, trimmed — or "" when there isn't a usable one, or it's switched off. */
async function launchpadBase() {
  const { baseUrl, enabled } = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  if (!enabled) return "";
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

/* Dismissal is remembered per pull request for the life of the tab. sessionStorage rather than
   chrome.storage because that is exactly the lifetime wanted: "not for this one, not right now",
   without teaching the extension a preference it would then have to let you un-teach. */
const dismissKey = (target) => `launchpad-offer-dismissed:${target}`;
const dismissed = (target) => {
  try { return sessionStorage.getItem(dismissKey(target)) === "1"; } catch { return false; }
};
const remember = (target) => {
  try { sessionStorage.setItem(dismissKey(target), "1"); } catch { /* private mode; forget it */ }
};

function remove() {
  document.getElementById(HOST_ID)?.remove();
}

/**
 * Show the offer for `target`, or move an existing one to it.
 *
 * Built in a shadow root because the page around it is not ours: Azure DevOps ships a large stylesheet
 * that would otherwise reach in, and anything this script adds to the page could equally well be
 * caught by ADO's own selectors. The shadow boundary is what makes the thing look the same on the
 * light theme, the dark theme, and whatever ADO ships next.
 */
function show(target) {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    const link = existing.shadowRoot?.querySelector("a");
    if (link && link.href !== target) link.href = target;
    return;
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  /* The positioning lives on the host rather than inside the shadow root so it cannot be reached by
     page CSS, and the z-index is the maximum because ADO's own overlays are ambitious. */
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .pill {
        display: flex; align-items: center; gap: 2px;
        font: 500 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: #161b22; color: #e6edf3;
        border: 1px solid #30363d; border-radius: 999px;
        box-shadow: 0 4px 14px rgba(0,0,0,.28);
        padding: 3px 4px 3px 3px;
        animation: rise .16s ease-out;
      }
      @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
      /* Somebody who has asked for less motion is not asking for a pill that slides in. */
      @media (prefers-reduced-motion: reduce) { .pill { animation: none; } }

      a, button {
        font: inherit; color: inherit; border: 0; background: transparent;
        border-radius: 999px; cursor: pointer;
      }
      a {
        display: flex; align-items: center; gap: 7px;
        padding: 7px 11px; text-decoration: none; white-space: nowrap;
      }
      a:hover { background: #21262d; }
      a:focus-visible, button:focus-visible { outline: 2px solid #58a6ff; outline-offset: -2px; }
      .mark { font-size: 14px; line-height: 1; }
      button {
        width: 26px; height: 26px; font-size: 15px; line-height: 1;
        color: #8b949e; flex: none;
      }
      button:hover { background: #21262d; color: #e6edf3; }
    </style>
    <div class="pill">
      <a><span class="mark" aria-hidden="true">🧠</span><span>Open in Launchpad</span></a>
      <button type="button" title="Not for this pull request" aria-label="Dismiss">&times;</button>
    </div>
  `;

  const link = root.querySelector("a");
  link.href = target;
  /* Same tab: this is "take me there instead", not "and also open this". The ADO page is one Back
     away, which is the whole reason for offering rather than redirecting. */

  root.querySelector("button").addEventListener("click", () => {
    remember(target);
    remove();
  });

  document.documentElement.appendChild(host);
}

let showing = null;

/** Decide, for whatever URL the page is on now, whether the offer belongs here. */
async function evaluate() {
  const [{ launchpadUrlFor }, base] = await Promise.all([rules, launchpadBase()]);

  const target = base ? launchpadUrlFor(location.href, base) : null;
  if (!target || dismissed(target)) {
    if (showing) { remove(); showing = null; }
    return;
  }

  showing = target;
  show(target);
}

/* Azure DevOps is a single-page app: clicking from one pull request to the next changes the URL
   without a navigation, so there is no event this script is told about. Polling the URL is the
   unglamorous answer, and the right one — a string compare every second is nothing next to what the
   page itself is doing, and it is immune to however ADO chooses to route tomorrow. */
let last = location.href;
setInterval(() => {
  if (location.href === last) return;
  last = location.href;
  evaluate();
}, 1000);

// Toggling the extension off, or correcting the address, should take effect on the page in front of
// you rather than at the next reload.
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "sync") evaluate(); });

evaluate();
