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

**The redirect is declarative.** A `declarativeNetRequest` rule rewrites the URL before the request
leaves the browser, so no ADO page loads first and nothing flashes. `background.js` runs no code on
the hot path — it exists only to keep the rules in step with the options, because a static rule file
would have to hardcode the Launchpad address, and that address is the one thing that genuinely varies.

**Scoped to `main_frame`.** Only a link someone clicked is ever affected. Azure DevOps's own API
calls, iframes and assets are untouched, and every other page on the host works normally.

**Nothing is sent anywhere.** No content script, no analytics, no network access of its own. The two
host permissions exist because `declarativeNetRequest` needs them to redirect requests to those hosts.

**Off means off, not broken.** With the checkbox cleared, or no address set, the rules are removed
rather than pointed somewhere useless — so links go to Azure DevOps exactly as they did before. That
matters because ADO is still where branch policies, work items and completion live.

## Tests

```bash
node extension/rules.test.mjs
```

Twelve cases over the URL shapes ADO actually serves, including the ones that must *not* redirect —
the pull request **list** page is the trap, since its path is the singular form plus one character.

The test parses the rules out of `background.js` rather than restating them. A copy would pass while
the shipped rule was broken, which is the one failure mode a test like this must not have.

## Known limitation

A link to a pull request that has since **merged or been abandoned** will open the review page with
nothing selected. Launchpad's pull request list is fetched with `status=active`, so a completed PR is
not in it to select. Links in Slack outlive pull requests, so this will come up — it needs Launchpad
to fetch a named pull request directly rather than hoping it is in the active list.
