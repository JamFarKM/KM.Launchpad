/**
 * What counts as a pull request link, and where it goes.
 *
 * A module of its own so two things can share it without either restating it: the declarative rules
 * in background.js, and the `webNavigation` fallback beside them. It is also the only part worth
 * testing, and being importable means `rules.test.mjs` exercises the shipped code rather than a copy
 * of it — a copy would pass while the shipped rule was broken, which is the one failure mode a test
 * like this must not have.
 *
 * Nothing here touches `chrome.*`, which is what keeps it importable from plain Node.
 */

/**
 * The URL shapes Azure DevOps actually serves, which is more than one.
 *
 * `{org}/{project}/_git/{repo}/pullrequest/{id}` is the usual form — but when a repository has the
 * same name as its project, ADO drops the project segment entirely and serves
 * `{org}/{repo}/pullrequest/{id}`. That is the common case for a service whose repo is its project,
 * so leaving it out would mean the extension silently did nothing for exactly those repositories.
 *
 * `visualstudio.com` is the pre-2018 host. Old links outlive the rename, and old links are precisely
 * what this is for.
 *
 * Anything after the id — `?_a=files`, a `discussionId`, a fragment — is deliberately dropped rather
 * than carried over: those are Azure DevOps's own view state and mean nothing to Launchpad. The
 * trailing `.*` is what consumes them.
 */
export const SHAPES = [
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

/** A backslash, spelled without writing one — see `launchpadUrlFor`. */
const BACKSLASH = String.fromCharCode(92);

/**
 * The Launchpad URL for an Azure DevOps URL, or null if it isn't a pull request.
 *
 * This resolves the same `\1`-style backreferences Chrome's `regexSubstitution` does, so the
 * declarative rule and the fallback agree by construction rather than by review. A substitution looks
 * like `\1/\2/\3`: splitting on the backslash leaves the leading literal, then one part per
 * backreference whose first character is the group number and whose remainder is literal text.
 *
 * The backslash comes from a char code because every layer between source and disk — shell, heredoc,
 * editor — has its own opinion about doubled backslashes, and two of them silently halved the escape
 * while this was written as a regex literal.
 */
export function launchpadUrlFor(url, base) {
  for (const shape of SHAPES) {
    const match = url.match(new RegExp(shape.filter));
    if (!match) continue;

    const substituted = shape.substitution
      .split(BACKSLASH)
      .map((part, i) => (i === 0 ? part : match[Number(part[0])] + part.slice(1)))
      .join("");

    return `${base}/review/${substituted}`;
  }
  return null;
}
