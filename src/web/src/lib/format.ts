import type { Run } from "../types";

export type StatusTone = "success" | "failed" | "running" | "canceled" | "idle";

export function runTone(run: Run | undefined): StatusTone {
  if (!run) return "idle";
  if (run.state === "inProgress" || run.state === "notStarted") return "running";
  switch (run.result) {
    case "succeeded":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "partiallySucceeded":
      return "failed";
    default:
      return "idle";
  }
}

export function runLabel(run: Run | undefined): string {
  if (!run) return "no runs";
  if (run.state === "inProgress") return "running";
  if (run.state === "notStarted") return "queued";
  return run.result ?? run.state;
}

export function isTerminal(run: Run | undefined): boolean {
  return !!run && run.state === "completed";
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Short relative time for the single-line run row: "4h", "12d". */
export function timeAgoShort(iso?: string | null): string {
  if (!iso) return "";
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * Branch label: only the segment after the last "/" (§2.3) — the full ref goes
 * in title=. "refs/heads/feature/bonus-eligibility" → "bonus-eligibility".
 */
export function branchShort(ref?: string | null): string {
  if (!ref) return "—";
  const clean = ref.replace(/^refs\/heads\//, "");
  const seg = clean.split("/").filter(Boolean).pop();
  return seg || clean;
}

/**
 * Strip a leading service prefix from a verbose pipeline name so sequence steps
 * fit the card. Fallback for steps with no author-set alias:
 * "SB.ConfigRegistry.Tooling - Deploy" → "Tooling - Deploy".
 */
export function stepShort(name: string, prefix?: string): string {
  let s = name.trim();
  if (prefix) {
    const p = prefix.trim();
    if (p && s.toLowerCase().startsWith(p.toLowerCase())) {
      s = s.slice(p.length).replace(/^[\s.\-–—:·]+/, "");
    }
  }
  return s || name;
}

/** The longest common dot/space-delimited prefix shared by every step name. */
export function commonPrefix(names: string[]): string {
  if (names.length < 2) return "";
  const parts = names.map((n) => n.split(/(?=[.\s\-])/));
  const first = parts[0];
  let i = 0;
  while (i < first.length && parts.every((p) => p[i]?.toLowerCase() === first[i]?.toLowerCase())) i++;
  return first.slice(0, i).join("");
}

export function duration(run: Run): string {
  if (!run.startTime) return "";
  const start = new Date(run.startTime).getTime();
  const end = run.finishTime ? new Date(run.finishTime).getTime() : Date.now();
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
