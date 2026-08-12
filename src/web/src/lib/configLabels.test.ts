import { describe, expect, it } from "vitest";
import type { ConfigSetting } from "../types";
import {
  canonical, commonLines, groupByKey, isCompact, markLines, preview, sameValue, valueTypeOf,
} from "./configLabels";

const s = (key: string, value: string, label?: string): ConfigSetting => ({ key, value, label: label ?? null });

describe("sameValue — parsed, not stringly (§7.1)", () => {
  it("treats reordered JSON keys as the same configuration", () => {
    expect(sameValue('{"a":1,"b":2}', '{ "b": 2, "a": 1 }')).toBe(true);
  });

  it("treats reformatted whitespace as the same configuration", () => {
    expect(sameValue('{"a":1}', '{\n  "a": 1\n}')).toBe(true);
  });

  it("still sees a real difference", () => {
    expect(sameValue('{"a":1}', '{"a":2}')).toBe(false);
  });

  it("does not confuse a nested reorder with a change", () => {
    expect(sameValue('{"o":{"x":1,"y":2}}', '{"o":{"y":2,"x":1}}')).toBe(true);
  });

  it("keeps array order significant", () => {
    expect(sameValue("[1,2]", "[2,1]")).toBe(false);
  });

  it("trims non-JSON values", () => {
    expect(sameValue(" int ", "int")).toBe(true);
    expect(sameValue("int", "prod")).toBe(false);
  });

  it("does not treat a number and its string form as equal", () => {
    expect(sameValue("12", '"12"')).toBe(false);
  });
});

describe("canonical (§7.2)", () => {
  it("formats both sides identically regardless of input shape", () => {
    expect(canonical('{"b":2,"a":1}')).toBe(canonical('{ "a": 1,\n "b": 2 }'));
  });

  it("leaves scalars alone", () => {
    expect(canonical("12")).toBe("12");
    expect(canonical(" int ")).toBe("int");
  });
});

describe("groupByKey", () => {
  const settings = [
    s("AccaBonus:10000000", '{"minOdd":1.35}'),
    s("AccaBonus:10000000", '{"minOdd":1.35}', "staging"),
    s("AccaBonus:20050000", '{"minOdd":1.35}'),
    s("AccaBonus:20050000", '{"minOdd":1.20}', "staging"),
    s("AccaBonus:20050000", '{"minOdd":1.20}', "canary"),
  ];

  it("collapses per-label rows into one entry per key", () => {
    const g = groupByKey(settings);
    expect(g.map((x) => x.key)).toEqual(["AccaBonus:10000000", "AccaBonus:20050000"]);
    expect(g[0].labels).toHaveLength(2);
    expect(g[1].labels).toHaveLength(3);
  });

  it("orders baseline first, then named labels alphabetically", () => {
    const g = groupByKey(settings)[1];
    expect(g.labels.map((l) => l.label)).toEqual(["", "canary", "staging"]);
  });

  it("reports drift only for labels that actually differ", () => {
    const g = groupByKey(settings);
    expect(g[0].drift).toEqual([]);
    // canary and staging agree with each other, so the lone baseline is the odd one out.
    expect(g[1].drift).toEqual([""]);
    expect(g[1].distinct).toBe(2);
  });

  it("treats the largest agreeing group as the shared value", () => {
    const g = groupByKey([
      s("K", "a"), s("K", "b", "one"), s("K", "b", "two"), s("K", "b", "three"),
    ])[0];
    expect(g.common?.raw).toBe("b");
    expect(g.drift).toEqual([""]);
  });

  it("breaks a tie towards the baseline, which is what resolves by default", () => {
    const g = groupByKey([s("K", "a"), s("K", "b", "one")])[0];
    expect(g.common?.raw).toBe("a");
    expect(g.drift).toEqual(["one"]);
  });

  it("does not flag drift for a reordered-but-identical label (§7.1)", () => {
    const g = groupByKey([
      s("K", '{"a":1,"b":2}'),
      s("K", '{ "b": 2, "a": 1 }', "staging"),
    ]);
    expect(g[0].drift).toEqual([]);
  });

  it("reports MIXED when the labels don't even agree on the shape", () => {
    const g = groupByKey([s("K", "12"), s("K", '{"a":1}', "staging")]);
    expect(g[0].type).toBe("MIXED");
  });

  it("reports the one type when every label agrees on it", () => {
    const g = groupByKey([s("K", "12"), s("K", "20", "staging")]);
    expect(g[0].type).toBe("INT");
  });

  describe("a key with only named labels (§4)", () => {
    const only = groupByKey([
      s("K", "12", "staging"), s("K", "12", "canary"), s("K", "20", "prod"),
    ])[0];

    it("has no baseline rather than nominating one", () => {
      expect(only.baseline).toBeNull();
    });

    it("still compares the labels against each other", () => {
      expect(only.drift).toEqual(["prod"]);
      expect(only.distinct).toBe(2);
    });

    it("says nothing differs when they all agree", () => {
      const g = groupByKey([s("K", "12", "staging"), s("K", "12", "canary")])[0];
      expect(g.drift).toEqual([]);
      expect(g.distinct).toBe(1);
    });

    it("still lists every label, alphabetically", () => {
      expect(only.labels.map((l) => l.label)).toEqual(["canary", "prod", "staging"]);
    });

    it("reports the shared type when labels agree", () => {
      expect(only.type).toBe("INT");
    });

    it("reports MIXED when they do not", () => {
      const g = groupByKey([s("K", "12", "staging"), s("K", "true", "canary")])[0];
      expect(g.type).toBe("MIXED");
    });
  });
});

describe("commonLines / markLines — what varies across the labels", () => {
  it("marks the line that differs, in every label that holds a variant", () => {
    const values = ['{"a":1,"b":2}', '{"a":1,"b":9}'];
    const shared = commonLines(values);
    expect(markLines(values[0], shared).filter((l) => l.changed).map((l) => l.text.trim()))
      .toEqual(['"b": 2']);
    expect(markLines(values[1], shared).filter((l) => l.changed).map((l) => l.text.trim()))
      .toEqual(['"b": 9']);
  });

  it("marks nothing when every label agrees, despite key order", () => {
    const shared = commonLines(['{"b":2,"a":1}', '{"a":1,"b":2}']);
    expect(markLines('{"b":2,"a":1}', shared).some((l) => l.changed)).toBe(false);
  });

  it("keeps a line shared by all three unmarked while marking the one that varies", () => {
    const values = ['{"a":1,"b":1}', '{"a":1,"b":2}', '{"a":1,"b":3}'];
    const shared = commonLines(values);
    const marks = markLines(values[1], shared);
    expect(marks.filter((l) => l.changed).map((l) => l.text.trim())).toEqual(['"b": 2']);
    expect(marks.some((l) => !l.changed && l.text.includes('"a"'))).toBe(true);
  });

  it("produces no blank line between rows", () => {
    expect(markLines('{"a":1}', commonLines(['{"a":1}'])).some((l) => l.text === "")).toBe(false);
  });

  it("marks a line one label repeats more often than the others", () => {
    const shared = commonLines(["[1]", "[1,1]"]);
    expect(markLines("[1,1]", shared).filter((l) => l.changed)).toHaveLength(1);
  });
});

describe("isCompact (§10)", () => {
  it("is compact when every value is a short one-liner", () => {
    expect(isCompact(groupByKey([s("K", "12"), s("K", "20", "staging")])[0])).toBe(true);
  });

  it("is not compact when any value is multi-line", () => {
    expect(isCompact(groupByKey([s("K", "12"), s("K", '{"a":1}', "staging")])[0])).toBe(false);
  });

  it("is not compact past the length cap", () => {
    expect(isCompact(groupByKey([s("K", "x".repeat(61))])[0])).toBe(false);
  });
});

describe("valueTypeOf / preview", () => {
  it("types values without calling JSON a string", () => {
    expect(valueTypeOf('{"a":1}')).toBe("JSON");
    expect(valueTypeOf("true")).toBe("BOOL");
    expect(valueTypeOf("12")).toBe("INT");
    expect(valueTypeOf("hello")).toBe("STR");
  });

  it("previews a JSON object by its keys", () => {
    expect(preview('{"minOdd":1,"mode":"flat"}')).toBe("{ minOdd, mode }");
  });

  it("previews an array by its length", () => {
    expect(preview("[1,2,3]")).toBe("[ 3 items ]");
  });
});
