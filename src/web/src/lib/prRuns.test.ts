import { describe, expect, it } from "vitest";
import { groupByPipeline, overallTone } from "./prRuns";
import type { Run } from "../types";

const run = (id: number, pipelineId: number, queueTime: string, over: Partial<Run> = {}): Run => ({
  id, pipelineId, queueTime, state: "completed", result: "succeeded", webUrl: "",
  pipelineName: `p${pipelineId}`, ...over,
} as Run);

describe("groupByPipeline", () => {
  it("puts each pipeline's newest run first, and the most recently run pipeline first", () => {
    const groups = groupByPipeline([
      run(1, 10, "2026-10-01T10:00:00Z"),
      run(2, 20, "2026-10-01T12:00:00Z"),
      run(3, 10, "2026-10-01T11:00:00Z"),
    ]);
    expect(groups.map((g) => g.pipelineId)).toEqual([20, 10]);
    expect(groups[1].runs.map((r) => r.id)).toEqual([3, 1]);
  });

  it("names a pipeline the payload didn't", () => {
    expect(groupByPipeline([run(1, 7, "2026-10-01T10:00:00Z", { pipelineName: null })])[0].name).toBe("Pipeline 7");
  });
});

describe("overallTone", () => {
  it("is null with no runs, rather than an idle state that reads as one", () => {
    expect(overallTone([])).toBeNull();
  });

  it("judges each pipeline by its latest run only", () => {
    const groups = groupByPipeline([
      run(1, 10, "2026-10-01T10:00:00Z", { result: "failed" }),
      run(2, 10, "2026-10-01T11:00:00Z"),
    ]);
    expect(overallTone(groups)).toEqual({ tone: "success", label: "Latest run succeeded" });
  });

  it("lets one failure outrank anything still running", () => {
    const groups = groupByPipeline([
      run(1, 10, "2026-10-01T10:00:00Z", { result: "failed" }),
      run(2, 20, "2026-10-01T11:00:00Z", { state: "inProgress", result: null }),
    ]);
    expect(overallTone(groups)).toEqual({ tone: "failed", label: "1 of 2 pipelines failing" });
  });
});
