# Sequences inside Views — design spec (addendum to DESIGN_SPEC.md)

**Status:** approved mockup, ready to implement
**Scope:** information architecture + a new sequence editor panel. The sequence *data model* gains a display name and explicit parameter bindings (§6) — everything else is presentation.
**Reference files:**

| File | What it is |
|---|---|
| `src/web/design/sequences-in-views-v1.html` | Interactive mockup. Ground truth for anything this doc doesn't pin down. |
| `src/web/design/DESIGN_SPEC.md` | Parent spec. Invariants A1–A6 apply unchanged. |
| `src/web/design/launchpad-tokens.css` | Existing tokens. This change adds three aliases (§2), no new colours. |

The mockup's black harness bar — the two "Try:" buttons — **is not part of the product**. Neither is the struck-through `Sequences` nav tab; it's shown only to make the removal legible.

---

## 1. What this supersedes

In `DESIGN_SPEC.md` §2.1 (Global chrome), two bullets are replaced:

- **Nav tabs.** The tab list becomes `Views · Review · Configurations · Key Vault`. `Sequences` is removed. Everything else about nav tabs (text labels, 14px monochrome icons, no emoji, ink-coloured active state) is unchanged.
- **Sidebar drawer.** The drawer is no longer pipelines-only. It becomes a two-tab **library** (§4).

Nothing in invariants A1–A6 changes. Note in particular that the new binding-source colours are aliases of existing identity hues, so A2 needs no further carve-out.

**Routing:** keep `/sequences` alive as a redirect to the Views board rather than 404-ing it. Bookmarks and any links in existing docs or chat history will point there.

---

## 2. Tokens

No new colours. Three semantic aliases, so the binding chips read as a set and can be re-pointed later without hunting for hex:

```css
:root {
  --src-input:   var(--hue-violet);   /* a pre-run input        */
  --src-step:    var(--hue-aqua);     /* an earlier step output */
  --src-literal: var(--hue-slate);    /* a typed literal        */
}
```

A **broken** binding uses `--status-warn`, which is correct rather than an A2 violation — an unresolvable reference is a genuine warning state, not an identity.

Geometry: library drawer `266px`, editor panel `500px`. Both are columns of the same grid as the board:

```css
.work { display:grid; grid-template-columns: var(--wl,0px) minmax(0,1fr) var(--wr,0px);
        transition: grid-template-columns .18s ease; }
.work[data-drawer="on"] { --wl:266px; }
.work[data-editor="on"] { --wr:500px; }
```

---

## 3. Why this shape — read before changing it

Two facts about sequences drive every decision below, and a future change that ignores them will land badly:

1. **Views consumes sequences; the editor authors them.** These are different tasks with different information needs. The editor is not a card and must not be crammed into one.
2. **A sequence is a library object, not view-local.** The same sequence can appear on shelves in several views. This is why sequences keep a global list (in the library drawer) rather than living only inside whichever view happens to reference them, and why §7 exists.

A tempting alternative — *a sequence is just a shelf with "run in order" enabled* — was considered and rejected. Shelves are view-local, so it destroys cross-view reuse, and a shelf has nowhere to put pre-run inputs or step-to-step value passing, which is most of what a sequence is.

---

## 4. The library drawer

The existing pipeline drawer gains tabs: **Pipelines** and **Sequences**, each with a count. The search field filters the active tab and its placeholder changes to match.

- **Pipelines tab** — unchanged from the current drawer: grouped by service, each row draggable onto a shelf.
- **Sequences tab** — flat list, `name` + step count, each row draggable onto a shelf, and a pencil button on hover that opens the editor. A `+ New sequence` button pinned to the drawer footer, visible only on this tab.

Both lists being draggable is the point: a pipeline and a sequence are both "a thing you put on a shelf," and the drawer was already where you got those.

---

## 5. Editing in context

A sequence card's `⋯` menu gains **Edit sequence…** as its first item, opening the editor panel on the right. This is the same slide-in pattern as the Configurations detail pane — reuse that component rather than building a second one.

- **The card under edit gets an accent treatment** (`--accent-tint` background, 2px `--accent` inset rail) so the panel's target is never ambiguous when several sequence cards are on screen.
- **Opening the editor collapses the library drawer.** You don't need the library while editing, and drawer + board + editor is one pane too many at common window widths. Do not animate both at once — set both attributes in the same frame so it reads as one transition.
- Editing a display name or the sequence name **updates the board live**, before save. The board is the preview.

### Editor anatomy, top to bottom

| Region | Contents |
|---|---|
| Header | `SEQ` tag, inline-editable sequence name, close `✕` |
| Usage disclosure | See §7 |
| Pre-run inputs | Table: key (mono, editable), type badge, default (editable), remove. `+ Add` |
| Steps | Ordered, collapsible step cards. `+ Add step` |
| Footer | `Save changes` (accent) · `Discard` (outline) · unsaved indicator · run button |

### Step cards

Each step is a card in `--bg-surface-2` with a hairline border:

- Drag grip, a numbered index chip, then a two-line name block: **display name as an inline-editable field** (12.5px/600) with the **real pipeline name beneath it** in 10.5px muted monospace.
- A chevron collapses/expands the parameter list. Collapsed is the default for steps you aren't touching; the mockup opens a couple for illustration.
- The display name is what appears on the shelf card and in binding chips that reference this step's output. This is the feature that makes `SB.ConfigRegistry.UserTypesMap · Deploy` fit in a 236px card.

---

## 6. Parameter bindings

Every step parameter has exactly one source. Render it as a chip: a 5px colour square, the reference in monospace, and a caret.

| Source | Chip class | Reference form | Renders as |
|---|---|---|---|
| Pre-run input | `k-input` (violet) | `inputs.<key>` | `inputs.branch` |
| Earlier step output | `k-step` (aqua) | `<stepIndex>.<outputName>` | `<step display name>.imageTag` |
| Literal | `k-lit` (slate) | raw string | `"Release"` |

Clicking a chip opens a grouped picker: **Pre-run inputs** / **Outputs from earlier steps** / **Literal**.

**The picker must only offer steps strictly earlier than the current one.** That is the cycle-prevention mechanism — a cycle is then not expressible in the UI and needs no separate validation pass. Do not "helpfully" list all steps.

Step outputs are stored by **index**, not by display name, so renaming a step never breaks a binding. The chip resolves the index to the current display name at render time. Reordering steps *does* need to remap indices — see §10.

### Broken bindings

A binding is broken when it references an input that no longer exists, or a step index that is missing or is at/after the current step. When broken:

- the chip switches to `--status-warn` (`k-bad`) and shows the raw unresolved reference,
- the step card border goes `--status-warn`,
- a warning line appears under the step header: *"A parameter points at something that no longer exists."*

This must be **live**, not save-time. Deleting the `packageVersion` input from `ConfigRegistry Nuget SuperBuild` in the mockup breaks eight steps immediately and visibly. That instant feedback is the main thing this editor buys over the old form, and it is the single most important behaviour in this spec.

Saving with broken bindings should warn but need not be blocked — half-finished edits are normal.

---

## 7. Usage disclosure

The separate Sequences page implicitly told you "this is a shared object." In-context editing removes that signal, so it has to be put back deliberately.

The editor header carries a `--status-warn`-tinted band with a left rule: **"Used by N views — edits apply everywhere,"** followed by a chip per view (clickable, navigates to that view). When a sequence is on no view, replace it with a quieter line: *"Not on any view yet. Drag it from the library onto a shelf."*

Destructive edits — deleting a step, deleting an input that steps reference — should name that view list in their confirmation.

`Betting Dev Ship` in the mockup is on two views so the plural case is visible.

---

## 8. Data model changes

Three additions. Confirm against the current sequence schema before wiring:

1. **`displayName` per step.** The verbose pipeline name stays as the reference; the display name is new, user-editable, and defaults to the pipeline name with the shared service prefix stripped.
2. **Explicit parameter bindings.** `{ name, source: { kind: 'input'|'step'|'literal', ref } }`. If bindings are currently implicit or string-templated, this is the real work in this change and should be its own step.
3. **`usedIn` derivation.** Needed for §7. Derive it by scanning view configs for references rather than storing it on the sequence — a stored copy will drift.

The view export/import schema will need to round-trip step display names. Check whether it tolerates unknown fields or needs a version bump (this is the same open question `DESIGN_SPEC.md` §7 raises for shelf accents — resolve both together).

---

## 9. Implementation order

1. **Library drawer tabs** (§4) — Sequences tab, drag-to-shelf, pencil affordance. Independent of the editor; ship it first so the nav tab can go.
2. **Nav removal + `/sequences` redirect** (§1).
3. **Editor shell** (§5) — panel plumbing, grid columns, card accent state, drawer auto-collapse. Name and display-name editing with live board updates. No bindings yet.
4. **Inputs table** (§5).
5. **Bindings** (§6) — model change first (§8.2), then chips, then the picker, then live validation. Largest step; consider splitting the model change out.
6. **Usage disclosure** (§7) — needs `usedIn` derivation from §8.3.
7. **Reorder** (§10) — last, because it interacts with binding indices.

---

## 10. Acceptance checks

- [ ] `Sequences` is gone from nav; `/sequences` redirects rather than 404s.
- [ ] Drawer has both tabs with correct counts; search filters the active tab only; `+ New sequence` shows on the Sequences tab only.
- [ ] A sequence dragged from the library lands on a shelf as a `SEQ` card.
- [ ] `⋯ → Edit sequence…` opens the panel, collapses the drawer, and accents the source card.
- [ ] Renaming a step updates the shelf card immediately, before saving.
- [ ] The binding picker on step 1 offers inputs and literals but **no** step outputs; on step 5 it offers steps 1–4 only.
- [ ] Deleting an input that steps reference breaks those chips and step borders **immediately**, with the warning line.
- [ ] Renaming a step does **not** break bindings that reference its output.
- [ ] Reordering steps remaps bindings correctly: a binding to "the step formerly at index 2" still points at the same step, and any binding that would now reference a later step is flagged rather than silently repointed.
- [ ] A sequence on two views reads `Used by 2 views` with both chips; a sequence on none shows the quiet variant.
- [ ] Dark mode: binding chips, type badges, the usage band and the amber warning state all remain legible.
- [ ] Greyscale the editor: broken bindings are still identifiable (the warning line and border carry it, not just colour).

---

## 11. Open questions

- **Sequence-level display name.** The board strips the shelf's service prefix from a sequence name to keep cards tidy, but this is string matching and it fails when the names diverge — the mockup shows `ConfigRegistry Nuget SuperBuild` overflowing the `Configuration Registry` shelf card while its neighbours read `Ship`. Recommend giving the sequence its own explicit short display name, exactly as its steps now have, rather than deriving one. Small addition to the editor header; wants a decision before §3 is built.
- **Is the usage warning too loud for the common case?** It's `--status-warn`-tinted even when a sequence is used by one view, which is most of them. Consider neutral styling at `N = 1` and the warning tint only at `N > 1`. Worth judging against the mockup before deciding.
- **Reorder mechanics.** Drag grips are present but not wired in the mockup. Decide whether reordering remaps binding indices automatically (and flags newly-invalid ones) or refuses a move that would invalidate a binding. The former is friendlier and matches the live-validation approach in §6.
- **Step output names.** The mockup hardcodes `imageTag` / `packageVersion` / `runId`. Real output names have to come from the pipeline definition; if that isn't queryable, the picker may need to accept a free-text output name with a caution.
