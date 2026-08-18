/**
 * The URL as a first-class way into the app.
 *
 * Launchpad had no router and no addressable state: the page, and the review page's
 * project/repository/pull request, all lived in React state. That was fine while the only way in was
 * clicking, and became a real gap the moment a pull request wanted a link — a Slack notification, a
 * Jira comment, a message to a colleague. There was no URL to send.
 *
 * Deliberately not `react-router`. Two paths and four values do not justify a dependency, a
 * `<Routes>` tree, and a second idea of what "the current page" means; `history.replaceState` plus a
 * parse of `location.pathname` is the whole requirement. If nested routes ever appear, swap this
 * file — nothing outside it knows how the URL is shaped.
 *
 * `replaceState`, not `pushState`, on purpose: picking a different pull request is not navigation the
 * reviewer wants to walk back through one entry at a time. The Back button should leave the app, not
 * step through the eleven PRs they skimmed.
 */

export type Page = "views" | "configurations" | "review" | "keyvault";

export interface Deeplink {
  page: Page;
  /** Review only. Absent when the link names a page but nothing within it. */
  project?: string;
  /** The repository's *name*, not its id — a link a human might type or read. */
  repo?: string;
  prId?: number;
}

const PAGES: Page[] = ["views", "configurations", "review", "keyvault"];

/**
 * Read the current URL.
 *
 * Unknown paths fall back to the board rather than erroring: a stale or hand-mangled link should
 * land somewhere useful, not on a blank page.
 */
export function read(pathname: string = window.location.pathname): Deeplink {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const page = PAGES.find((p) => p === parts[0]);
  if (!page) return { page: "views" };

  if (page !== "review") return { page };

  // /review/{project}/{repo}/{prId} — every segment after the first is optional, so /review alone
  // opens the page with nothing selected, exactly as clicking the tab does.
  const prId = parts[3] !== undefined ? Number(parts[3]) : undefined;
  return {
    page,
    project: parts[1],
    repo: parts[2],
    prId: Number.isFinite(prId) && prId! > 0 ? prId : undefined,
  };
}

/** The path for a link, with no origin — for `replaceState` and for building a shareable URL. */
export function path(link: Deeplink): string {
  const segments: string[] = [link.page];
  if (link.page === "review") {
    // Written in order and stopped at the first gap: a URL with a pull request but no repository
    // would be unparseable, and quietly emitting one is worse than emitting the shorter link.
    if (link.project) segments.push(link.project);
    if (link.project && link.repo) segments.push(link.repo);
    if (link.project && link.repo && link.prId) segments.push(String(link.prId));
  }
  return "/" + segments.map(encodeURIComponent).join("/");
}

/** Keep the address bar in step with what is on screen, without adding a history entry. */
export function write(link: Deeplink): void {
  const next = path(link);
  if (next !== window.location.pathname) window.history.replaceState(null, "", next);
}

/**
 * An absolute URL for sharing.
 *
 * `publicUrl` comes from the server when the deployment has been told its own address; without it
 * this falls back to the origin the reviewer is on, which is right for their own bookmarks and wrong
 * for anything they paste into a channel — `localhost:8080` resolves to a colleague's own machine.
 * The caller decides whether that matters.
 *
 * `origin` is a parameter rather than read straight from `window`, so this module stays pure and
 * testable. `window` is only touched when neither argument is supplied.
 */
export function shareable(
  link: Deeplink,
  publicUrl?: string | null,
  origin?: string,
): string {
  const base = (publicUrl?.trim() || origin || window.location.origin).replace(/\/+$/, "");
  return base + path(link);
}
