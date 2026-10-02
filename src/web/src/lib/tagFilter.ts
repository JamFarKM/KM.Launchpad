import { api } from "../api/client";
import type { Run, ViewItem } from "../types";

/**
 * A pipeline card's run filter (DESIGN_SPEC.md §2.3). `include` is all-of, `exclude` is any-of;
 * the server applies both (RunTagFilter.cs), so this module only normalises, keys and describes.
 */
export interface TagFilter {
  include: string[];
  exclude: string[];
}

/** Trimmed, blank-free, case-insensitively unique — the server treats tags the same way. */
export function cleanTags(tags: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const t = raw.trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function tagFilterOf(item: ViewItem): TagFilter {
  return { include: cleanTags(item.includeTags), exclude: cleanTags(item.excludeTags) };
}

export function isTagFilterEmpty(f: TagFilter): boolean {
  return f.include.length === 0 && f.exclude.length === 0;
}

/**
 * The card and the shelf health pill must share one cache entry, so both build their query here.
 * Tags are sorted and lower-cased in the key only, so reordering a filter doesn't refetch.
 * The key still starts `["runs", project]`, which is what invalidation after a launch matches on.
 */
export function runsQuery(item: ViewItem, top = 4) {
  const f = tagFilterOf(item);
  const keyOf = (ts: string[]) => ts.map((t) => t.toLowerCase()).sort();
  return {
    queryKey: ["runs", item.project, item.pipelineId, keyOf(f.include), keyOf(f.exclude)] as const,
    queryFn: () => api.runs(item.project, item.pipelineId, top, f),
  };
}

/** One line for the card: `tagged prod, release · not nightly`. Empty when there's no filter. */
export function describeTagFilter(f: TagFilter): string {
  const parts: string[] = [];
  if (f.include.length) parts.push(`tagged ${f.include.join(", ")}`);
  if (f.exclude.length) parts.push(`not ${f.exclude.join(", ")}`);
  return parts.join(" · ");
}

/** A run row's tooltip suffix, so it's visible why a run passed the filter. */
export function runTagsSuffix(run: Run): string {
  return run.tags?.length ? ` — tags: ${run.tags.join(", ")}` : "";
}
