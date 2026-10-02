import { describe, expect, it } from "vitest";
import type { ViewItem } from "../types";
import { itemKey, newItemId, sameItem, withItemIds, wouldDuplicate } from "./viewItems";

const pipe = (over: Partial<ViewItem> = {}): ViewItem => ({
  kind: "pipeline", project: "Sportsteam", pipelineId: 7, name: "deploy", shelf: "A", ...over,
});

describe("withItemIds", () => {
  it("adopts the pre-id key for stored cards, so saved views keep their meaning", () => {
    const [p, s] = withItemIds([
      pipe(),
      { kind: "sequence", project: "", pipelineId: 0, sequenceId: "s1", name: "release" },
    ]);
    expect(p.id).toBe("pipe:Sportsteam:7");
    expect(s.id).toBe("seq:s1");
  });

  it("keeps ids that are already there", () => {
    const it = pipe({ id: "c_abc" });
    expect(withItemIds([it])[0]).toBe(it);
  });

  it("separates copies that would otherwise share an id", () => {
    const ids = withItemIds([pipe(), pipe({ shelf: "B" }), pipe({ id: "pipe:Sportsteam:7" })]).map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("identity", () => {
  it("tells two copies of one pipeline apart", () => {
    const a = pipe({ id: newItemId() });
    const b = pipe({ id: newItemId(), shelf: "B" });
    expect(sameItem(a, b)).toBe(false);
    expect(itemKey(a)).not.toBe(itemKey(b));
  });

  it("mints distinct ids", () => {
    expect(new Set(Array.from({ length: 50 }, newItemId)).size).toBe(50);
  });
});

describe("wouldDuplicate", () => {
  const shelfOf = (i: ViewItem) => i.shelf ?? "A";

  it("allows the same pipeline on another shelf", () => {
    expect(wouldDuplicate([pipe()], "Sportsteam", 7, "B", shelfOf)).toBe(false);
  });

  it("refuses an unfiltered copy beside an unfiltered copy", () => {
    expect(wouldDuplicate([pipe()], "Sportsteam", 7, "A", shelfOf)).toBe(true);
  });

  it("allows a second copy beside a filtered one, since they show different runs", () => {
    expect(wouldDuplicate([pipe({ includeTags: ["prod"] })], "Sportsteam", 7, "A", shelfOf)).toBe(false);
  });

  it("matches on project as well as pipeline id", () => {
    expect(wouldDuplicate([pipe()], "Other", 7, "A", shelfOf)).toBe(false);
  });
});
