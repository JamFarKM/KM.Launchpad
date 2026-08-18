# Pull requests in Launchpad

A browser extension that sends Azure DevOps pull request links to Launchpad instead — whether the
link is in Slack, Jira, an email, or an ADO notification.

Launchpad itself cannot do this. A `dev.azure.com` link resolves to Azure DevOps in the browser; the
app never sees the click. Only something sitting in the browser can intervene, which is what this is.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked**, and pick this `extension/` folder.
4. Click the extension's icon and set the **Launchpad address** if it isn't `http://localhost:8080`.

No build step, no dependencies, nothing to compile — the folder is the extension.

After changing any file here, press **Reload** on the extension's card. The rules are rebuilt from the
options on install and on browser start, and a reload is what re-runs that.

## What it does

| You click | You get |
|---|---|
| `dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}` | `{launchpad}/review/{project}/{repo}/{id}` |
| `dev.azure.com/{org}/_git/{repo}/pullrequest/{id}` | `{launchpad}/review/{repo}/{repo}/{id}` |
| the same two on `*.visualstudio.com` | the same |
| anything else on those hosts | Azure DevOps, untouched |

The second row is not a special case worth skipping: when a repository has the same name as its
project, ADO drops the project segment from the URL entirely. Miss it and the extension silently does
nothing for exactly those repositories.

Query strings and fragments are dropped — `?_a=files`, `discussionId`, a comment anchor. Those are
Azure DevOps's own view state and mean nothing here. Percent-encoding is preserved, so a project with
a space in its name survives.

## Design notes

**Two paths, and both are needed.** The primary is declarative: a `declarativeNetRequest` rule
rewrites the URL before the request leaves the browser, so no ADO page loads first and nothing flashes.
`background.js` runs no code on that path — it only keeps the rules in step with the options, because a
static rule file would have to hardcode the Launchpad address, and that address is the one thing that
genuinely varies.

**The fallback exists because the rule alone does not work from Slack.** Chrome silently skips a
`redirect` rule when the extension has no host access to the *initiator* of the request. A link clicked
inside a web app — Slack in a tab, Jira, Outlook on the web — has that app as its initiator, so the rule
does nothing, while the very same URL pasted into the address bar redirects perfectly. No error, no
warning, nothing in any console: the rules are installed and simply never fire.

The alternative was requesting every site you might click a link from, which for a link rewriter is far
more access than it deserves. `webNavigation` has no initiator rule — it reports navigations for the
hosts this extension already has permission for, which is exactly Azure DevOps. It stays the fallback
because it is worse when the rule does work: by then ADO has begun loading, so there is a brief flash.
When the rule fires first, the fallback sees a Launchpad URL, matches nothing, and does nothing.

**Scoped to `main_frame`.** Only a link someone clicked is ever affected. Azure DevOps's own API
calls, iframes and assets are untouched, and every other page on the host works normally.

**Nothing is sent anywhere.** No content script, no analytics, no network access of its own. The two
host permissions exist because both paths need them to act on those hosts, and they are the only two
hosts named anywhere in the extension.

**Off means off, not broken.** With the checkbox cleared, or no address set, the rules are removed
rather than pointed somewhere useless — so links go to Azure DevOps exactly as they did before. That
matters because ADO is still where branch policies, work items and completion live.

## Tests

```bash
node extension/rules.test.mjs
```

Thirteen cases over the URL shapes ADO actually serves, including the ones that must *not* redirect —
the pull request **list** page is the trap, since its path is the singular form plus one character, and
a Launchpad URL must not match either or the fallback would redirect its own redirect.

It imports `rules.js` directly, which is why that module is separate from `background.js`: the
assertions run against the shipped matcher. An earlier version parsed the rules out of the source and
resolved the backreferences itself, which would have passed happily while the shipped code was broken.

## Known limitation

A link to a pull request that has since **merged or been abandoned** will open the review page with
nothing selected. Launchpad's pull request list is fetched with `status=active`, so a completed PR is
not in it to select. Links in Slack outlive pull requests, so this will come up — it needs Launchpad
to fetch a named pull request directly rather than hoping it is in the active list.
