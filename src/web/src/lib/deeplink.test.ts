import { describe, expect, it } from "vitest";
import { path, read, shareable } from "./deeplink";

describe("read", () => {
  it("reads a full review link", () => {
    expect(read("/review/Account/SA.Phase1.Migrations/80494")).toEqual({
      page: "review", project: "Account", repo: "SA.Phase1.Migrations", prId: 80494,
    });
  });

  it("reads a page with nothing selected", () => {
    expect(read("/review")).toEqual({ page: "review", project: undefined, repo: undefined, prId: undefined });
  });

  it("decodes segments, so a project with a space survives the round trip", () => {
    const link = { page: "review" as const, project: "My Project", repo: "SA.Web", prId: 12 };
    expect(read(path(link))).toEqual(link);
  });

  it("falls back to the board for an unknown path", () => {
    // A stale or hand-mangled link should land somewhere useful rather than on a blank page.
    expect(read("/nonsense/deeper")).toEqual({ page: "views" });
    expect(read("/")).toEqual({ page: "views" });
  });

  it("ignores a pull request id that isn't a positive number", () => {
    expect(read("/review/Account/Repo/notanumber").prId).toBeUndefined();
    expect(read("/review/Account/Repo/0").prId).toBeUndefined();
    expect(read("/review/Account/Repo/-3").prId).toBeUndefined();
  });
});

describe("path", () => {
  it("stops at the first gap rather than emitting an unparseable link", () => {
    // A URL carrying a pull request but no repository could not be read back, so the shorter link
    // is the honest one.
    expect(path({ page: "review", prId: 80494 })).toBe("/review");
    expect(path({ page: "review", project: "Account", prId: 80494 })).toBe("/review/Account");
  });

  it("ignores review fields on other pages", () => {
    expect(path({ page: "views", project: "Account", prId: 1 })).toBe("/views");
  });
});

describe("shareable", () => {
  it("prefers the deployment's configured address", () => {
    expect(shareable({ page: "review", project: "A", repo: "R", prId: 7 }, "https://launchpad.internal"))
      .toBe("https://launchpad.internal/review/A/R/7");
  });

  it("tolerates a trailing slash on the configured address", () => {
    expect(shareable({ page: "views" }, "https://launchpad.internal/")).toBe("https://launchpad.internal/views");
  });

  it("falls back to the current origin when nothing is configured", () => {
    // Right for the reviewer's own bookmark, wrong for a shared channel — which is the caller's
    // decision to make, not this function's.
    expect(shareable({ page: "views" }, null, "http://localhost:8080")).toBe("http://localhost:8080/views");
    expect(shareable({ page: "views" }, "   ", "http://localhost:8080")).toBe("http://localhost:8080/views");
  });
});
