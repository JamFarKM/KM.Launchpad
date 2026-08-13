import { describe, expect, it } from "vitest";
import { branchShort, durationShort, timeAgoShort } from "./format";

/** POLISH §1.4 — these must never produce a string long enough to be clipped mid-unit. */
const LONGEST_ACCEPTABLE = 8;

describe("durationShort", () => {
  it("uses seconds under a minute", () => {
    expect(durationShort(52_000)).toBe("52s");
  });

  it("uses minutes and seconds under an hour", () => {
    expect(durationShort(63_000)).toBe("1m 3s");
    expect(durationShort(148_000)).toBe("2m 28s");
  });

  it("drops a zero seconds remainder", () => {
    expect(durationShort(120_000)).toBe("2m");
  });

  it("rolls over into hours — a 90 minute run is not 90m", () => {
    expect(durationShort(90 * 60_000)).toBe("1h 30m");
    expect(durationShort(64 * 60_000)).toBe("1h 4m");
  });

  it("drops a zero minutes remainder", () => {
    expect(durationShort(3600_000)).toBe("1h");
  });

  it("never returns a negative duration", () => {
    expect(durationShort(-5000)).toBe("0s");
  });

  it("stays short enough that truncation never applies", () => {
    for (const ms of [0, 999, 59_000, 61_000, 3599_000, 3661_000, 86_400_000, 8_640_000_000]) {
      expect(durationShort(ms).length).toBeLessThanOrEqual(LONGEST_ACCEPTABLE);
    }
  });
});

describe("timeAgoShort", () => {
  const now = Date.parse("2026-08-13T12:00:00Z");
  const ago = (ms: number) => timeAgoShort(new Date(now - ms).toISOString(), now);

  it("counts seconds, minutes, hours and days", () => {
    expect(ago(30_000)).toBe("30s");
    expect(ago(5 * 60_000)).toBe("5m");
    expect(ago(4 * 3600_000)).toBe("4h");
    expect(ago(12 * 86_400_000)).toBe("12d");
  });

  it("degrades to a date past a month rather than growing unboundedly", () => {
    expect(ago(31 * 86_400_000)).not.toMatch(/d$/);
    expect(ago(400 * 86_400_000)).not.toMatch(/d$/);
  });

  it("still says 30d at the boundary", () => {
    expect(ago(30 * 86_400_000)).toBe("30d");
  });

  it("never goes negative for a clock skewed into the future", () => {
    expect(timeAgoShort(new Date(now + 60_000).toISOString(), now)).toBe("0s");
  });

  it("is empty for a missing timestamp", () => {
    expect(timeAgoShort(null)).toBe("");
    expect(timeAgoShort(undefined)).toBe("");
  });

  it("stays short enough that truncation never applies, up to the date fallback", () => {
    for (const ms of [0, 59_000, 3599_000, 86_400_000, 30 * 86_400_000]) {
      expect(ago(ms).length).toBeLessThanOrEqual(LONGEST_ACCEPTABLE);
    }
  });
});

describe("branchShort", () => {
  it("keeps only the last segment", () => {
    expect(branchShort("refs/heads/feature/bonus-eligibility")).toBe("bonus-eligibility");
  });

  it("leaves a bare name alone", () => {
    expect(branchShort("develop")).toBe("develop");
  });

  it("has a placeholder for nothing", () => {
    expect(branchShort(null)).toBe("—");
  });
});
