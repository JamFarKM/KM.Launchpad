import { describe, expect, it } from "vitest";
import type { ViewItem } from "../types";
import { cleanTags, describeTagFilter, isTagFilterEmpty, runsQuery, tagFilterOf } from "./tagFilter";

const item = (over: Partial<ViewItem> = {}): ViewItem => ({
  kind: "pipeline", project: "Sportsteam", pipelineId: 7, name: "deploy", ...over,
});

describe("cleanTags", () => {
  it("trims, drops blanks and dedupes case-insensitively, keeping the first spelling", () => {
    expect(cleanTags([" prod ", "", "PROD", "  ", "release"])).toEqual(["prod", "release"]);
  });

  it("treats a missing list as empty", () => {
    expect(cleanTags(null)).toEqual([]);
    expect(cleanTags(undefined)).toEqual([]);
  });
});

describe("runsQuery", () => {
  it("keeps the un-filtered key's prefix, so post-launch invalidation still matches", () => {
    expect(runsQuery(item()).queryKey.slice(0, 3)).toEqual(["runs", "Sportsteam", 7]);
  });

  it("keys on the filter, so a filtered card never shares an unfiltered card's cache entry", () => {
    expect(runsQuery(item()).queryKey).not.toEqual(runsQuery(item({ includeTags: ["prod"] })).queryKey);
    expect(runsQuery(item({ includeTags: ["prod"] })).queryKey)
      .not.toEqual(runsQuery(item({ excludeTags: ["prod"] })).queryKey);
  });

  it("ignores order and case, which don't change the result", () => {
    expect(runsQuery(item({ includeTags: ["b", "A"] })).queryKey)
      .toEqual(runsQuery(item({ includeTags: ["a", "B"] })).queryKey);
  });
});

describe("describeTagFilter", () => {
  it("says nothing when there is no filter", () => {
    const f = tagFilterOf(item());
    expect(isTagFilterEmpty(f)).toBe(true);
    expect(describeTagFilter(f)).toBe("");
  });

  it("states both halves in reading order", () => {
    expect(describeTagFilter({ include: ["prod", "release"], exclude: ["nightly"] }))
      .toBe("tagged prod, release · not nightly");
    expect(describeTagFilter({ include: [], exclude: ["nightly"] })).toBe("not nightly");
  });
});
