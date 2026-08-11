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

export function duration(run: Run): string {
  if (!run.startTime) return "";
  const start = new Date(run.startTime).getTime();
  const end = run.finishTime ? new Date(run.finishTime).getTime() : Date.now();
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
