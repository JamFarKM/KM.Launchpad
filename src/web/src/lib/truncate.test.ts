import { describe, expect, it } from "vitest";
import { ELLIPSIS, groupConsecutive, middleTruncate } from "./truncate";

/** A fixed-width font: every character is 10px wide. Keeps the budgets easy to reason about. */
const mono = (s: string) => s.length * 10;
const fit = (text: string, px: number, headRatio?: number) =>
  middleTruncate(text, px, mono, headRatio);

describe("middleTruncate", () => {
  it("leaves text that already fits alone", () => {
    expect(fit("short", 200)).toBe("short");
  });

  it("never exceeds the budget", () => {
    for (let px = 30; px <= 240; px += 10) {
      expect(mono(fit("acca-bonus-ladder-switch", px))).toBeLessThanOrEqual(px);
    }
  });

  it("uses as much of the budget as it can", () => {
    // 12 chars of room: the result should be 12 wide, not conservatively shorter.
    expect(fit("acca-bonus-ladder-switch", 120)).toHaveLength(12);
  });

  it("keeps the tail, which is where identifiers differ", () => {
    expect(fit("acca-bonus-ladder-switch", 120).endsWith("switch")).toBe(true);
  });

  it("distinguishes names that share a long prefix — the case this exists for", () => {
    const branches = [
      "acca-bonus-ladder-switch",
      "acca-bonus-ladder-rollback",
      "acca-bonus-ladder-hotfix",
      "acca-bonus-ladder-revert",
    ];
    const shown = branches.map((b) => fit(b, 150));
    expect(new Set(shown).size).toBe(4);
  });

  it("would NOT distinguish them under tail truncation (the bug being fixed)", () => {
    const tail = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + ELLIPSIS);
    const shown = ["acca-bonus-ladder-switch", "acca-bonus-ladder-rollback"].map((b) => tail(b, 15));
    expect(new Set(shown).size).toBe(1);
  });

  it("puts exactly one ellipsis in the middle", () => {
    const out = fit("acca-bonus-ladder-switch", 130);
    expect(out.split(ELLIPSIS)).toHaveLength(2);
    expect(out.startsWith(ELLIPSIS)).toBe(false);
    expect(out.endsWith(ELLIPSIS)).toBe(false);
  });

  it("gives the head more room at a balanced ratio", () => {
    const biased = fit("SB.OfferIntegrationProxyApi - Dev - universal deploy", 200, 0.34);
    const balanced = fit("SB.OfferIntegrationProxyApi - Dev - universal deploy", 200, 0.5);
    const headOf = (s: string) => s.split(ELLIPSIS)[0].length;
    expect(headOf(balanced)).toBeGreaterThan(headOf(biased));
  });

  it("handles a budget too small for anything useful without throwing", () => {
    expect(mono(fit("acca-bonus-ladder-switch", 10))).toBeLessThanOrEqual(10);
  });

  it("returns empty for empty input", () => {
    expect(fit("", 100)).toBe("");
  });

  it("returns the text unchanged when the width is unknown", () => {
    // clientWidth is 0 before layout; rendering the full string beats rendering an ellipsis.
    expect(fit("acca-bonus-ladder-switch", 0)).toBe("acca-bonus-ladder-switch");
  });
});

describe("groupConsecutive", () => {
  const run = (branch: string, id: number) => ({ branch, id });

  it("collapses a repeated branch into one group", () => {
    const groups = groupConsecutive(
      [run("x", 1), run("x", 2), run("x", 3), run("x", 4)],
      (r) => r.branch,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(4);
  });

  it("keeps non-adjacent groups separate, preserving the timeline", () => {
    const groups = groupConsecutive(
      [run("x", 1), run("y", 2), run("x", 3)],
      (r) => r.branch,
    );
    expect(groups.map((g) => g.key)).toEqual(["x", "y", "x"]);
  });

  it("gives a single run its own group rather than special-casing it away", () => {
    const groups = groupConsecutive([run("x", 1)], (r) => r.branch);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
  });

  it("handles an empty list", () => {
    expect(groupConsecutive([], (r: { branch: string }) => r.branch)).toEqual([]);
  });
});
