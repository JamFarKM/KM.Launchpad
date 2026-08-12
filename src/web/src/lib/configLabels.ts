import type { ConfigSetting } from "../types";

/**
 * Configurations, grouped one row per key with its labels stacked (CONFIG_LABELS §4, §7).
 *
 * The store hands back one setting per key *per label*, so a key carrying three labels arrives as
 * three rows. Everything here reshapes that into one entry per key and answers the question the
 * page exists for: does this key differ between its labels?
 */

/** App Configuration's no-label value is the empty label. */
export const NO_LABEL = "";

export type ValueType = "JSON" | "BOOL" | "INT" | "STR" | "MIXED";

export interface LabelValue {
  /** "" for the baseline, otherwise the label name. */
  label: string;
  setting: ConfigSetting;
  raw: string;
}

export interface KeyGroup {
  key: string;
  /** Baseline first when present, then named labels alphabetically. */
  labels: LabelValue[];
  /** The no-label value, or null when the key exists only under named labels (§4). */
  baseline: LabelValue | null;
  /**
   * The value most of this key's labels agree on — the yardstick the others are measured
   * against. Ties go to the baseline when there is one, otherwise the first label.
   */
  common: LabelValue | null;
  /** Labels whose value differs from `common`. Empty when every label agrees. */
  drift: string[];
  /** How many distinct values the labels hold between them. 1 means they all agree. */
  distinct: number;
  type: ValueType;
}

// ---------------------------------------------------------------- comparison

/**
 * Parse for comparison. A value that is JSON has to be compared as JSON: `{"a":1,"b":2}` and
 * `{ "b": 2, "a": 1 }` are the same configuration, and a string comparison would call that drift
 * and make the marker noise nobody trusts (§7).
 */
export function parseValue(raw: string | null | undefined): unknown {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { return JSON.parse(s); } catch { /* not JSON after all — fall through to the string */ }
  }
  return s;
}

/** Structural equality, order-insensitive for object keys. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Do two stored values mean the same thing? Parsed for JSON, trimmed for everything else. */
export function sameValue(a: string | null | undefined, b: string | null | undefined): boolean {
  return deepEqual(parseValue(a), parseValue(b));
}

/**
 * The form both sides are rendered and line-diffed in. Object keys are sorted, because two values
 * that differ only somewhere deep would otherwise light up every line whose key order happened to
 * differ. The detail pane already pretty-prints rather than echoing the stored text, so this only
 * extends a reformat that was happening anyway.
 */
export function canonical(raw: string | null | undefined): string {
  const parsed = parseValue(raw);
  if (typeof parsed !== "object" || parsed === null) return String(parsed);
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(parsed), null, 2);
}

// ---------------------------------------------------------------- typing

export function valueTypeOf(raw: string | null | undefined): Exclude<ValueType, "MIXED"> {
  const s = (raw ?? "").trim();
  if (!s) return "STR";
  if (s === "true" || s === "false") return "BOOL";
  if (/^-?\d+(\.\d+)?$/.test(s)) return "INT";
  if (typeof parseValue(s) === "object") return "JSON";
  return "STR";
}

// ---------------------------------------------------------------- grouping

/**
 * Reshape the flat per-label settings into one entry per key.
 *
 * The comparison is **between the labels**, not against the baseline. Labels are environments
 * here, and the question the page is opened to answer is "do these environments differ from each
 * other?" — which a baseline-relative comparison cannot answer at all for the many keys that have
 * no no-label value.
 *
 * §4 still holds for *identity*: the baseline is the no-label value and nothing else, and a key
 * that has none is not silently given one. It just no longer decides what counts as drift.
 */
export function groupByKey(settings: ConfigSetting[]): KeyGroup[] {
  const byKey = new Map<string, LabelValue[]>();
  for (const s of settings) {
    const entry: LabelValue = { label: s.label ?? NO_LABEL, setting: s, raw: s.value ?? "" };
    const list = byKey.get(s.key);
    if (list) list.push(entry); else byKey.set(s.key, [entry]);
  }

  const out: KeyGroup[] = [];
  for (const [key, entries] of byKey) {
    const baseline = entries.find((e) => e.label === NO_LABEL) ?? null;
    const named = entries
      .filter((e) => e.label !== NO_LABEL)
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

    const labels = baseline ? [baseline, ...named] : named;

    // Group the labels by what they actually hold, then take the largest group as the common
    // value. The odd ones out are what you want to see, and that works with or without a baseline.
    const buckets: { rep: LabelValue; members: LabelValue[] }[] = [];
    for (const lv of labels) {
      const b = buckets.find((x) => sameValue(x.rep.raw, lv.raw));
      if (b) b.members.push(lv); else buckets.push({ rep: lv, members: [lv] });
    }
    const best = buckets.reduce((a, b) => {
      if (b.members.length !== a.members.length) return b.members.length > a.members.length ? b : a;
      // A tie is settled by the baseline, which is at least the value the app resolves by default.
      return a.members.some((m) => m.label === NO_LABEL) ? a
        : b.members.some((m) => m.label === NO_LABEL) ? b : a;
    }, buckets[0]);

    const common = best?.rep ?? null;
    const drift = common ? labels.filter((l) => !sameValue(l.raw, common.raw)).map((l) => l.label) : [];

    // Typed from the value most labels hold, and reported as MIXED when they don't even agree on
    // the shape — which is a thing worth seeing rather than hiding behind whichever one won.
    const types = new Set(labels.map((l) => valueTypeOf(l.raw)));
    const type: ValueType = types.size === 1 ? [...types][0] : "MIXED";

    out.push({ key, labels, baseline, common, drift, distinct: buckets.length, type });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: "base" }));
}

// ---------------------------------------------------------------- rendering helpers

export interface DiffLine {
  text: string;
  changed: boolean;
}

const lineCounts = (raw: string | null | undefined): Map<string, number> => {
  const m = new Map<string, number>();
  for (const l of canonical(raw).split("\n")) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};

/**
 * The lines every one of these values holds, as a multiset — the shared skeleton of the key.
 * Anything outside it is a line that varies somewhere, which is exactly what wants highlighting.
 */
export function commonLines(values: (string | null | undefined)[]): Map<string, number> {
  if (values.length === 0) return new Map();
  let acc = lineCounts(values[0]);
  for (const v of values.slice(1)) {
    const c = lineCounts(v);
    const next = new Map<string, number>();
    for (const [line, n] of acc) {
      const shared = Math.min(n, c.get(line) ?? 0);
      if (shared > 0) next.set(line, shared);
    }
    acc = next;
  }
  return acc;
}

/**
 * Canonical lines of `raw`, flagging those that aren't part of the shared skeleton.
 *
 * Counted rather than set-tested, so a line one label repeats more often than the others still
 * reads as a difference.
 */
export function markLines(raw: string | null | undefined, common: Map<string, number>): DiffLine[] {
  const budget = new Map(common);
  return canonical(raw).split("\n").map((text) => {
    const n = budget.get(text) ?? 0;
    if (n > 0) { budget.set(text, n - 1); return { text, changed: false }; }
    return { text, changed: true };
  });
}

/**
 * §10: stacked sections are too much furniture for a key whose every value is a short one-liner.
 * Gated on *every* value so a key with a scalar baseline and a JSON label stays stacked rather
 * than switching rendering mode halfway down.
 */
export const COMPACT_MAX = 60;

export function isCompact(group: KeyGroup): boolean {
  return group.labels.length > 0 && group.labels.every((l) => {
    const c = canonical(l.raw);
    return !c.includes("\n") && c.length <= COMPACT_MAX;
  });
}

/** A short one-liner for the key list's value column. */
export function preview(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const parsed = parseValue(s);
  if (Array.isArray(parsed)) return `[ ${parsed.length} item${parsed.length === 1 ? "" : "s"} ]`;
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as object);
    return keys.length ? `{ ${keys.join(", ")} }` : "{ }";
  }
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
