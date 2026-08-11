import type { Run } from "../types";
import { runLabel, runTone } from "../lib/format";

export function RunBadge({ run }: { run: Run | undefined }) {
  const tone = runTone(run);
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" />
      {runLabel(run)}
    </span>
  );
}
