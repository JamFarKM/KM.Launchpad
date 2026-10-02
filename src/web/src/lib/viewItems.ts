import type { SavedView, ViewItem } from "../types";

// Not lib/tagFilter: that imports the API client, and the client imports this module.
const hasTagFilter = (i: ViewItem): boolean =>
  [...(i.includeTags ?? []), ...(i.excludeTags ?? [])].some((t) => t.trim().length > 0);

/**
 * A card's identity on a view. A pipeline can sit on several shelves at once (and twice on one
 * shelf with different tag filters), so identity is a per-card `id`, not the pipeline.
 *
 * Cards saved before ids existed were unique per pipeline (or per sequence), so that key is a safe
 * id for them: `withItemIds` adopts it, and it's persisted the next time the view is saved.
 */
const legacyKey = (i: ViewItem): string =>
  i.kind === "sequence" ? `seq:${i.sequenceId}` : `pipe:${i.project}:${i.pipelineId}`;

export const itemKey = (i: ViewItem): string => i.id ?? legacyKey(i);
export const sameItem = (a: ViewItem, b: ViewItem): boolean => itemKey(a) === itemKey(b);

/**
 * `crypto.getRandomValues`, not `randomUUID`: the latter only exists in a secure context, and a
 * self-hosted Launchpad is often served over plain http on an internal hostname.
 */
export function newItemId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return "c_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Gives every card an id, and makes ids unique even if stored data somehow repeats one. */
export function withItemIds(items: ViewItem[]): ViewItem[] {
  const seen = new Set<string>();
  return items.map((i) => {
    let id = itemKey(i);
    for (let n = 2; seen.has(id); n++) id = `${itemKey(i)}#${n}`;
    seen.add(id);
    return id === i.id ? i : { ...i, id };
  });
}

export const withViewItemIds = (v: SavedView): SavedView => ({ ...v, items: withItemIds(v.items) });

/**
 * Whether adding this pipeline to `shelf` would only make an exact duplicate: a new card is
 * unfiltered, so it duplicates an unfiltered copy already on that shelf. A filtered copy is a
 * different card (`deploy · tagged prod` beside `deploy · tagged qa`), so it doesn't count.
 */
export function wouldDuplicate(
  items: ViewItem[], project: string, pipelineId: number, shelf: string, shelfOf: (i: ViewItem) => string,
): boolean {
  return items.some((i) =>
    i.kind !== "sequence" && i.project === project && i.pipelineId === pipelineId
    && shelfOf(i) === shelf && !hasTagFilter(i));
}
