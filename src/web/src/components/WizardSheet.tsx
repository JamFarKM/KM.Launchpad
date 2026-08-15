import { useEffect, useMemo, useState } from "react";
import { ChangeMapDiagram, styleName } from "./ChangeMapDiagram";
import type { ChangeMap } from "../types";

interface Props {
  map: ChangeMap;
  prTitle: string;
  connectorName: string;
  /** Jump the diff to a file and close the wizard. */
  onCite: (path: string, line: number) => void;
  onClose: () => void;
  /** Run the map again on the current commit. */
  onRemap: () => void;
}

/**
 * The wizard (DESIGN_SPEC_CHANGE_MAP.md §8): a guided walkthrough of the pull request.
 *
 * <b>Two panes that are one thing.</b> The map on the left is the whole change at a glance; the deck
 * on the right walks it a step at a time. The current slide drives which area of the map is lit, so
 * "where am I" and "what is happening here" are answered in the same glance rather than by the
 * reviewer holding a position in their head. Clicking an area on the map jumps the deck to it — the
 * relationship runs both ways.
 *
 * The narration is `flow[].detail` from the map itself, which the §2 schema asks for per step: what
 * happens here, what this pull request changed about it, and how that serves what it set out to do.
 * Nothing here composes prose of its own — a wizard that wrote its own commentary would be inventing
 * claims the agent never made, which is the whole thing §5.2's honesty rules exist to prevent.
 */
export function WizardSheet({ map, prTitle, connectorName, onCite, onClose, onRemap }: Props) {
  const [i, setI] = useState(0);

  const steps = map.flow;
  const byId = useMemo(() => new Map(map.groups.map((g) => [g.id, g])), [map.groups]);
  const step = steps[i];
  const last = steps.length - 1;
  const go = (n: number) => setI(Math.max(0, Math.min(last, n)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // The deck is the primary control here, so the arrows drive it rather than scrolling a pane.
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(i - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, i, last]);

  /* A map with no flow has nothing to walk: a pure refactor, a schema-only migration. The map is
     still worth showing, so the wizard degrades to just the diagram rather than refusing to open. */
  const hasWalk = steps.length > 0;

  return (
    <div className="map-overlay" onClick={onClose}>
      <div className="wz-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="map-sheet-head">
          <span className="map-sheet-title">Walkthrough</span>
          <span
            className={`map-pill ${map.styleBasis === "structure" ? "structure" : "inferred"}`}
            title={map.styleBasis === "structure"
              ? "The folders, projects or a checked-in doc say so outright."
              : "The agent's read of this repo's shape — not a build-system fact."}
          >
            {map.styleBasis === "structure" ? "FROM STRUCTURE" : "INFERRED"} · {styleName(map.style)}
          </span>
          {map.commitSha && <span className="map-commit">{map.commitSha.slice(0, 7)}</span>}
          <span style={{ flex: 1 }} />
          <button className="ag-mini" onClick={onRemap} title="Run the walkthrough again on the current commit">
            Re-map
          </button>
          <button className="ag-mini" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="wz-main">
          <div className="wz-map">
            <ChangeMapDiagram
              map={map}
              focusGroup={step?.group ?? null}
              showFlow={hasWalk}
              pannable
              onPick={(id) => {
                // Jump to the first step that visits this area; ignore areas the flow never touches.
                const at = steps.findIndex((s) => s.group === id);
                if (at >= 0) go(at);
              }}
            />
          </div>

          <div className="wz-deck-pane">
            {!hasWalk ? (
              <div className="wz-empty">
                <b>No runtime path to walk.</b>
                <p>
                  This change has no single request or job to follow through the system — a refactor,
                  a schema-only migration, or configuration. The map beside this still shows what
                  changed and how the areas depend on each other.
                </p>
              </div>
            ) : (
              <>
                {/* The pack. Every slide is mounted and positioned by its distance from the current
                    one, so advancing is a transition between transforms rather than a mount — which
                    is what lets the outgoing card be *seen* going to the back of the pack. */}
                <div className="wz-deck">
                  {steps.map((s, k) => {
                    const off = k - i;
                    const g = byId.get(s.group);
                    return (
                      <article
                        key={s.step}
                        className="wz-card"
                        data-off={off < 0 ? "past" : off > 2 ? "deep" : String(off)}
                        aria-hidden={off !== 0}
                        style={{ zIndex: off < 0 ? 0 : 100 - off }}
                      >
                        <header className="wz-card-head">
                          <span className="wz-step">Step {s.step} of {steps.length}</span>
                          {g && g.findingCount > 0 && (
                            <span className="wz-find">{g.findingCount} review finding{g.findingCount === 1 ? "" : "s"}</span>
                          )}
                        </header>

                        <h3 className="wz-title">{s.action}</h3>
                        <div className="wz-where">{g?.name ?? s.group}</div>

                        {/* The agent's own narration for this step. */}
                        <p className="wz-detail">{s.detail || g?.summary || ""}</p>

                        {g && g.files.length > 0 && (
                          <div className="wz-files">
                            <div className="wz-files-label">Changed here</div>
                            {g.files.map((f) => (
                              <button key={f.path} className="map-file" title={f.path}
                                onClick={() => onCite(f.path, 1)}>
                                {f.path.split("/").pop()}
                                <span className="map-file-counts">
                                  {f.added > 0 && <span className="add">+{f.added}</span>}{" "}
                                  {f.removed > 0 && <span className="del">−{f.removed}</span>}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>

                <div className="wz-foot">
                  <button className="ag-mini" disabled={i === 0} onClick={() => go(i - 1)}>‹ Back</button>
                  <div className="wz-dots" role="tablist" aria-label="Walkthrough steps">
                    {steps.map((s, k) => (
                      <button
                        key={s.step}
                        role="tab"
                        aria-selected={k === i}
                        aria-label={`Step ${s.step}: ${s.action}`}
                        className={`wz-dot${k === i ? " on" : ""}${k < i ? " seen" : ""}`}
                        onClick={() => go(k)}
                      />
                    ))}
                  </div>
                  {i < last
                    ? <button className="btn small primary" onClick={() => go(i + 1)}>Next ›</button>
                    : <button className="btn small primary" onClick={onClose}>Done</button>}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="map-sheet-foot">
          Walking <b>{prTitle}</b>. Grouping and narration by <b>{connectorName}</b> — an agent's
          reading of the change, not a build-system fact. Arrow keys move between steps.
        </div>
      </div>
    </div>
  );
}
