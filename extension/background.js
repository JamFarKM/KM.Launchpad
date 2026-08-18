/*
 * One job: send an Azure DevOps pull request URL to Launchpad instead.
 *
 * There are two paths to that, and both are needed.
 *
 * The primary is declarative: a `declarativeNetRequest` rule rewrites the URL before the request
 * leaves the browser, so no page loads, nothing flashes, and no code runs on the hot path. This file
 * only keeps those rules in step with the options, because a *static* rule file would have to hardcode
 * the Launchpad address, and that address is the one thing that genuinely varies.
 *
 * The fallback is `webNavigation`, at the bottom, for the case the rules silently skip.
 *
 * Both are scoped to top-level navigation, so only a link somebody clicked is ever affected. Azure
 * DevOps's own API calls, iframes and assets are untouched, and every other page on the host works
 * normally.
 */
import { SHAPES, launchpadUrlFor } from "./rules.js";

const DEFAULTS = { baseUrl: "http://localhost:8080", enabled: true };

async function settings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/** The configured Launchpad address, trimmed — or "" when there isn't a usable one. */
async function launchpadBase() {
  const { baseUrl, enabled } = await settings();
  if (!enabled) return "";
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

/** Replace every rule this extension owns, in one call, so there is never a half-applied state. */
async function sync() {
  const base = await launchpadBase();

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  // No address, or switched off: remove the rules and leave the browser alone. Notably *not* a rule
  // that redirects nowhere — a broken redirect would strand the link, and doing nothing at least
  // leaves the reviewer on Azure DevOps, which is still where policies and work items live.
  const addRules = !base ? [] : SHAPES.map((shape, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: `${base}/review/${shape.substitution}` },
    },
    condition: {
      regexFilter: shape.filter,
      resourceTypes: ["main_frame"],
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

chrome.runtime.onInstalled.addListener(sync);
// Dynamic rules survive a restart, but the worker doesn't; re-syncing on startup keeps the rules and
// the options from drifting apart if storage was changed on another device.
chrome.runtime.onStartup.addListener(sync);
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "sync") sync(); });

/*
 * The fallback, and why it has to exist.
 *
 * Chrome silently skips a `redirect` rule when the extension has no host access to the *initiator* of
 * the request. A pull request link clicked inside a web app — Slack in a tab, Jira, Outlook on the web
 * — has that app as its initiator, so the rule does nothing, while the very same URL pasted into the
 * address bar redirects perfectly. That is the whole difference between "the rules are installed" and
 * "the rules fire", and it is invisible: no error, no warning, nothing in any console.
 *
 * The alternative was requesting every site a reviewer might click a link from, which for a link
 * rewriter is far more access than it deserves. `webNavigation` has no initiator rule: it reports
 * navigations for the hosts this extension already has permission for, which is exactly Azure DevOps.
 *
 * It stays the fallback rather than becoming the primary because it is strictly worse when the rule
 * does work — by the time this fires the ADO page has begun loading, so there is a brief flash the
 * declarative path doesn't have. When the rule fires first, this sees a Launchpad URL, matches
 * nothing, and does nothing, so the two never fight over the same navigation.
 */
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Top-level only: a pull request URL inside an iframe is not somebody opening a pull request.
  if (details.frameId !== 0) return;

  const base = await launchpadBase();
  if (!base) return;

  const target = launchpadUrlFor(details.url, base);
  if (target) chrome.tabs.update(details.tabId, { url: target });
}, { url: [{ hostEquals: "dev.azure.com" }, { hostSuffix: ".visualstudio.com" }] });
