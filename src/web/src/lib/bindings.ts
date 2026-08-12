import type { ParamBinding, Sequence, SequenceStep } from "../types";

/**
 * Parameter bindings (SEQUENCES §6).
 *
 * A step's parameters historically lived in four places: `templateParameters` and `variables`
 * held literals, `bindings` held pre-run input references, and `link` carried a single
 * step-to-step value that always read the immediately previous step. §6 wants one source per
 * parameter, chosen from any of the three kinds, naming any earlier step.
 *
 * Rather than migrate stored data, this reads all four into one normalised list and writes back
 * into the shapes the runner already understands: literals to the dictionaries, everything else
 * to `bindings` with an explicit kind. Old sequences therefore keep working untouched, and a
 * sequence saved from the editor is readable by the old runner path too.
 */

export type Src =
  | { kind: "input"; ref: string }        // ref = input id
  | { kind: "step"; ref: string }         // ref = "<stepIndex>.<output>"
  | { kind: "literal"; ref: string };     // ref = the value

export interface Param {
  target: "parameter" | "variable";
  name: string;
  src: Src;
}

const srcOf = (b: ParamBinding): Src => {
  // kind is absent on bindings written before §6; those are input bindings by definition.
  if (!b.kind) return { kind: "input", ref: b.inputId ?? "" };
  return { kind: b.kind, ref: b.ref ?? "" } as Src;
};

/** Every parameter this step sets, whichever channel it is currently stored in. */
export function paramsOf(step: SequenceStep): Param[] {
  const out: Param[] = [];
  const seen = new Set<string>();
  const key = (t: string, n: string) => `${t}:${n}`;

  for (const b of step.bindings ?? []) {
    out.push({ target: b.target, name: b.name, src: srcOf(b) });
    seen.add(key(b.target, b.name));
  }
  // A literal only counts if no binding already claims that name — a binding wins, which is the
  // precedence the runner has always applied (literals first, bindings overwrite).
  for (const [name, value] of Object.entries(step.templateParameters ?? {})) {
    if (seen.has(key("parameter", name))) continue;
    out.push({ target: "parameter", name, src: { kind: "literal", ref: value } });
  }
  for (const [name, value] of Object.entries(step.variables ?? {})) {
    if (seen.has(key("variable", name))) continue;
    out.push({ target: "variable", name, src: { kind: "literal", ref: value } });
  }
  return out;
}

/** Write a normalised list back into the step, splitting literals from references. */
export function applyParams(step: SequenceStep, params: Param[]): SequenceStep {
  const templateParameters: Record<string, string> = {};
  const variables: Record<string, string> = {};
  const bindings: ParamBinding[] = [];

  for (const p of params) {
    if (p.src.kind === "literal") {
      (p.target === "variable" ? variables : templateParameters)[p.name] = p.src.ref;
    } else {
      bindings.push({ target: p.target, name: p.name, kind: p.src.kind, ref: p.src.ref, inputId: null });
    }
  }
  return { ...step, templateParameters, variables, bindings };
}

export interface Resolved {
  /** What the chip shows. */
  label: string;
  ok: boolean;
  cls: "k-input" | "k-step" | "k-lit" | "k-bad";
}

/**
 * Resolves a source for display, live against the draft.
 *
 * Broken means: an input that no longer exists, or a step index that is missing or is at/after
 * this step. A broken chip shows the raw unresolved reference — hiding it behind a friendly
 * label would make the thing you need to fix harder to find.
 */
export function resolve(src: Src, seq: Sequence, stepIndex: number): Resolved {
  if (src.kind === "literal") {
    return { label: `"${src.ref}"`, ok: true, cls: "k-lit" };
  }

  if (src.kind === "input") {
    const input = seq.inputs.find((i) => i.id === src.ref);
    return input
      ? { label: `inputs.${input.name}`, ok: true, cls: "k-input" }
      : { label: `inputs.${src.ref || "?"}`, ok: false, cls: "k-bad" };
  }

  const dot = src.ref.indexOf(".");
  const idx = dot > 0 ? Number(src.ref.slice(0, dot)) : NaN;
  const output = dot > 0 ? src.ref.slice(dot + 1) : "";
  const target = Number.isInteger(idx) ? seq.steps[idx] : undefined;

  // At or after this step is refused, not merely warned about: that's what makes a cycle
  // inexpressible rather than something a separate validation pass has to catch.
  if (!target || idx >= stepIndex) {
    return { label: `${src.ref || "?"}`, ok: false, cls: "k-bad" };
  }
  // Resolved to the *current* display name, so renaming a step never breaks its references.
  const name = target.alias?.trim() || target.name || `step${idx + 1}`;
  return { label: `${name}.${output}`, ok: true, cls: "k-step" };
}

/** True when any parameter on this step points at something that no longer resolves. */
export const stepIsBroken = (step: SequenceStep, seq: Sequence, i: number) =>
  paramsOf(step).some((p) => !resolve(p.src, seq, i).ok);

/**
 * Rebuilds step-index references after a reorder (§10).
 *
 * `order[newIndex] = oldIndex`. Bindings are repointed at the step they always meant, so moving a
 * step never silently changes what a parameter reads. A reference that now lands at or after its
 * own step is left pointing where it does, which shows as broken — the spec's "flagged rather
 * than silently repointed".
 */
export function remapAfterReorder(steps: SequenceStep[], order: number[]): SequenceStep[] {
  const newIndexOfOld = new Map<number, number>();
  order.forEach((oldIndex, newIndex) => newIndexOfOld.set(oldIndex, newIndex));

  return order.map((oldIndex) => {
    const step = steps[oldIndex];
    const bindings = (step.bindings ?? []).map((b) => {
      if (b.kind !== "step" || !b.ref) return b;
      const dot = b.ref.indexOf(".");
      if (dot <= 0) return b;
      const target = Number(b.ref.slice(0, dot));
      const moved = newIndexOfOld.get(target);
      if (moved === undefined) return b;
      return { ...b, ref: `${moved}.${b.ref.slice(dot + 1)}` };
    });
    return { ...step, bindings };
  });
}
