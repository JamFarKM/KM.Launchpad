import { runTone, type StatusTone } from "./format";
import type { Run } from "../types";

export interface PipelineGroup {
  pipelineId: number;
  name: string;
  runs: Run[];
}

/**
 * Runs grouped by pipeline, the pipeline with the most recent run first.
 *
 * A PR gets re-queued: five validation runs of one pipeline would otherwise push the only run of the
 * other pipeline off the bottom, and "is this PR green?" is a question about each pipeline's *latest*
 * run, which grouping puts at the head of every group.
 */
export function groupByPipeline(runs: Run[]): PipelineGroup[] {
  const groups = new Map<number, PipelineGroup>();
  for (const r of runs) {
    const g = groups.get(r.pipelineId);
    if (g) g.runs.push(r);
    else groups.set(r.pipelineId, { pipelineId: r.pipelineId, name: r.pipelineName || `Pipeline ${r.pipelineId}`, runs: [r] });
  }
  const when = (r: Run) => new Date(r.queueTime ?? r.startTime ?? 0).getTime();
  for (const g of groups.values()) g.runs.sort((a, b) => when(b) - when(a));
  return [...groups.values()].sort((a, b) => when(b.runs[0]) - when(a.runs[0]));
}

/**
 * The PR's overall state, from each pipeline's latest run: one failure is a failure, else anything
 * still going is running. Null with no runs — there is no state to report, and an idle glyph would
 * read as one.
 */
export function overallTone(groups: PipelineGroup[]): { tone: StatusTone; label: string } | null {
  if (!groups.length) return null;
  const tones = groups.map((g) => runTone(g.runs[0]));
  const n = groups.length;
  const count = (t: StatusTone) => tones.filter((x) => x === t).length;
  const of = (k: number, word: string) => `${k} of ${n} pipeline${n === 1 ? "" : "s"} ${word}`;
  if (count("failed")) return { tone: "failed", label: of(count("failed"), "failing") };
  if (count("running")) return { tone: "running", label: of(count("running"), "running") };
  if (count("success") === n) return { tone: "success", label: n === 1 ? "Latest run succeeded" : `All ${n} pipelines succeeded` };
  return { tone: "canceled", label: of(count("canceled"), "canceled") };
}
