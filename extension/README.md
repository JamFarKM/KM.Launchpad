# Pull requests in Launchpad

A browser extension that offers an **Open in Launchpad** link on Azure DevOps pull request pages — a
small pill in the bottom-right corner. Click it to review the pull request in Launchpad; ignore it and
nothing has changed.

Launchpad cannot do this itself. It never sees the click: a `dev.azure.com` link resolves to Azure
DevOps, and only something sitting in the browser can add anything to that page.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked**, and pick this `extension/` folder.
4. Click the extension's icon and set the **Launchpad address** if it isn't `http://localhost:8080`.

No build step, no dependencies, nothing to compile — the folder is the extension. After changing any
file here, press **Reload** on the extension's card, then reload the ADO tab.

## What it does

| On this page | You get |
|---|---|
| `dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}` | a link to `{launchpad}/review/{project}/{repo}/{id}` |
| `dev.azure.com/{org}/_git/{repo}/pullrequest/{id}` | a link to `{launchpad}/review/{repo}/{repo}/{id}` |
| the same two on `*.visualstudio.com` | the same |
| anything else on those hosts | nothing at all |

The second row is not a special case worth skipping: when a repository has the same name as its
project, ADO drops the project segment from the URL entirely. Miss it and the extension silently does
nothing for exactly those repositories.

Query strings and fragments are dropped — `?_a=files`, `discussionId`, a comment anchor. Those are
Azure DevOps's own view state and mean nothing here. It also means the pill stays put, pointing at the
same place, while you click around one pull request's tabs. Percent-encoding is preserved, so a
project with a space in its name survives.

**×** dismisses the pill for that pull request until the tab is closed. It is `sessionStorage`, which
is exactly the lifetime wanted: "not this one, not now", without teaching the extension a preference
you would then have to un-teach.

## Design notes

**An offer, not a redirect.** The first version rewrote the URL before the request left the browser.
That was the wrong trade even when it worked: a pull request link points at Azure DevOps because ADO is
where branch policies, work items, approvals and completion live. Deciding for the reviewer that they
meant Launchpad was a guess, and a wrong guess cost them a page load and their place in the diff. Now
the link lands where it was pointed and the extension offers the other door.

**Which also removed the hardest problem.** Chrome silently skips a `declarativeNetRequest` redirect
when the extension has no host access to the *initiator* of the request. A link clicked inside a web
app — Slack in a tab, Jira, Outlook on the web — has that app as its initiator, so the rule did nothing
there, while the very same URL pasted into the address bar redirected perfectly. No error, no warning,
nothing in any console. The workaround was a `webNavigation` fallback and, avoided narrowly, asking for
access to every site you might click a link from. Nothing is redirected now, so there is no initiator
to have access to: the script runs on the ADO page itself, which `matches` already grants.

That is why the permissions are down to `storage` alone, and why `background.js` is gone.

**A shadow root, not the page.** The page around the pill is not ours. ADO ships a large stylesheet
that would otherwise reach in, and anything added to the page could equally well be caught by ADO's own
selectors. The shadow boundary is what makes the pill look the same on the light theme, the dark theme,
and whatever ADO ships next.

**The URL is polled.** ADO is a single-page app: clicking from one pull request to the next changes the
URL without a navigation, so there is no event the content script is told about. A string compare every
second is nothing next to what that page is already doing, and it is immune to however ADO chooses to
route tomorrow.

**Nothing is sent anywhere.** No network access of its own, no analytics. The Launchpad address is used
only to build the link you click.

**Off means the page is untouched.** With the checkbox cleared, or no address set, nothing is added.

## Tests

```bash
node extension/rules.test.mjs
```

Thirteen cases over the URL shapes ADO actually serves, including the ones that must *not* offer a
link — the pull request **list** page is the trap, since its path is the singular form plus one
character.

It imports `rules.js` directly, which is why that module is separate from the content script: the
assertions run against the shipped matcher. An earlier version parsed the rules out of the source and
resolved the backreferences itself, which would have passed happily while the shipped code was broken.

The pill itself has no test. It is DOM in a page this repo cannot host, and a test that mocked the page
would only assert that the mock behaves like the mock.

## Known limitation

A link to a pull request that has since **merged or been abandoned** will open the review page with
nothing selected. Launchpad's pull request list is fetched with `status=active`, so a completed PR is
not in it to select. Links in Slack outlive pull requests, so this will come up — it needs Launchpad to
fetch a named pull request directly rather than hoping it is in the active list.
