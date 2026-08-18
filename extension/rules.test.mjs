/*
 * The only test this extension can have, and the one that matters.
 *
 * There is no build step and no framework — the whole extension is four regexes, a storage read and a
 * navigation listener — so `node extension/rules.test.mjs` is the test suite.
 *
 * It imports `rules.js` directly, which is why that module exists separately from background.js: the
 * assertions run against the *shipped* matcher, not a reimplementation of it. An earlier version of
 * this file parsed the rules out of the source and resolved the backreferences itself, which would
 * have passed happily while the shipped code was broken.
 *
 * RE2 (what Chrome uses for `regexFilter`) and JS regexes agree on patterns this simple, so exercising
 * them here genuinely covers what the browser will do.
 */
import { SHAPES, launchpadUrlFor } from "./rules.js";

const BASE = "http://localhost:8080";

const cases = [
  ["the usual shape",
   "https://dev.azure.com/BetagyDevOps/Account/_git/SA.Phase1.Migrations/pullrequest/80494",
   `${BASE}/review/Account/SA.Phase1.Migrations/80494`],

  // When a repository is named after its project, ADO drops the project segment. That is the common
  // case for a service whose repo is its project, so missing it would mean the extension did nothing
  // for exactly those repositories.
  ["a repository named after its project",
   "https://dev.azure.com/BetagyDevOps/_git/SB.Placement/pullrequest/123",
   `${BASE}/review/SB.Placement/SB.Placement/123`],

  // ADO's own view state means nothing to Launchpad, so it is dropped rather than carried over.
  ["a query string",
   "https://dev.azure.com/BetagyDevOps/Account/_git/Repo/pullrequest/7?_a=files&path=%2Fx.sql",
   `${BASE}/review/Account/Repo/7`],
  ["a fragment",
   "https://dev.azure.com/BetagyDevOps/Account/_git/Repo/pullrequest/7#12345",
   `${BASE}/review/Account/Repo/7`],

  // Percent-encoding is preserved, which is what the app's decodeURIComponent expects.
  ["a project with a space",
   "https://dev.azure.com/Org/My%20Project/_git/Repo/pullrequest/9",
   `${BASE}/review/My%20Project/Repo/9`],

  // Old links outlive the 2018 rename, and old links in Slack are the whole point of this.
  ["the legacy host",
   "https://betagydevops.visualstudio.com/Account/_git/Repo/pullrequest/9",
   `${BASE}/review/Account/Repo/9`],
  ["the legacy host, project implied",
   "https://betagydevops.visualstudio.com/_git/Solo/pullrequest/4",
   `${BASE}/review/Solo/Solo/4`],

  // Everything that is not one pull request must be left alone. The list page is the trap: its path
  // is the singular form plus one character.
  ["a repository page", "https://dev.azure.com/BetagyDevOps/Account/_git/Repo", null],
  ["a build", "https://dev.azure.com/BetagyDevOps/Account/_build/results?buildId=1", null],
  ["the pull request *list*", "https://dev.azure.com/BetagyDevOps/Account/_git/Repo/pullrequests?_a=mine", null],
  ["a work item", "https://dev.azure.com/BetagyDevOps/Account/_workitems/edit/4245", null],
  ["another host entirely", "https://example.com/x/_git/y/pullrequest/1", null],

  // A Launchpad URL must not match, or the webNavigation fallback would redirect its own redirect.
  ["a Launchpad URL", `${BASE}/review/Account/Repo/7`, null],
];

if (SHAPES.length !== 4) {
  console.error(`expected 4 rule shapes, found ${SHAPES.length}`);
  process.exit(1);
}

let failed = 0;
for (const [name, url, want] of cases) {
  const got = launchpadUrlFor(url, BASE);
  if (got === want) {
    console.log(`ok    ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}\n        ${url}\n        got    ${got}\n        wanted ${want}`);
  }
}

console.log(failed ? `\n${failed} of ${cases.length} failed` : `\nall ${cases.length} pass`);
process.exit(failed ? 1 : 0);
