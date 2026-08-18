/*
 * One job: send an Azure DevOps pull request URL to Launchpad instead.
 *
 * The redirect itself is declarative — `declarativeNetRequest` rewrites the URL before the request
 * leaves the browser, so no page ever loads, nothing flashes, and this file runs no code on the hot
 * path. It exists only to keep the rules in step with the options, because a *static* rule file would
 * have to hardcode the Launchpad address, and that address is the one thing that genuinely varies.
 *
 * Scoped to `main_frame`, so it only ever affects a link someone clicked. Azure DevOps's own API calls,
 * iframes and assets are untouched, and every other page on the host still works normally.
 */

const DEFAULTS = { baseUrl: "http://localhost:8080", enabled: true };

/**
 * The URL shapes Azure DevOps actually serves, which is more than one.
 *
 * `{org}/{project}/_git/{repo}/pullrequest/{id}` is the usual form — but when a repository has the
 * same name as its project, ADO drops the project segment entirely and serves
 * `{org}/{repo}/pullrequest/{id}`. That is the common case for a service whose repo is its project,
 * so leaving it out would mean the extension silently did nothing for exactly those repositories.
 *
 * `visualstudio.com` is the pre-2018 host. Old links outlive the rename, and old links in Slack are
 * precisely what this is for.
 *
 * Anything after the id — `?_a=files`, a `discussionId`, a fragment — is deliberately dropped rather
 * than carried over: those are Azure DevOps's own view state and mean nothing to Launchpad. The
 * trailing `.*` is what consumes them.
 */
const SHAPES = [
  // org / project / _git / repo / pullrequest / id
  {
    filter: String.raw`^https://dev\.azure\.com/[^/?#]+/([^/?#]+)/_git/([^/?#]+)/pullrequest/(\d+).*`,
    substitution: String.raw`\1/\2/\3`,
  },
  // org / repo / pullrequest / id — the project is implied by the repository name.
  {
    filter: String.raw`^https://dev\.azure\.com/[^/?#]+/_git/([^/?#]+)/pullrequest/(\d+).*`,
    substitution: String.raw`\1/\1/\2`,
  },
  // The legacy host, both shapes.
  {
    filter: String.raw`^https://[^/?#]+\.visualstudio\.com/([^/?#]+)/_git/([^/?#]+)/pullrequest/(\d+).*`,
    substitution: String.raw`\1/\2/\3`,
  },
  {
    filter: String.raw`^https://[^/?#]+\.visualstudio\.com/_git/([^/?#]+)/pullrequest/(\d+).*`,
    substitution: String.raw`\1/\1/\2`,
  },
];

async function settings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/** Replace every rule this extension owns, in one call, so there is never a half-applied state. */
async function sync() {
  const { baseUrl, enabled } = await settings();
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  // No address, or switched off: remove the rules and leave the browser alone. Notably *not* a rule
  // that redirects nowhere — a broken redirect would strand the link, and doing nothing at least
  // leaves the reviewer on Azure DevOps.
  const addRules = !enabled || !base ? [] : SHAPES.map((shape, i) => ({
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
