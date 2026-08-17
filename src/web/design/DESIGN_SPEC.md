# Pipeline Launchpad — visual redesign spec

**Status:** approved mockup, ready to implement
**Scope:** presentation only. No data model, routing, or pipeline-execution changes.
**Reference files (commit alongside this doc):**

| File | What it is |
|---|---|
| `src/web/design/pipeline-launchpad-redesign-v4.html` | Interactive mockup. Open it in a browser. Ground truth for anything this doc doesn't pin down. |
| `src/web/design/launchpad-tokens.css` | Extracted tokens + component rules, written to be dropped into the real app. |

The mockup has a black harness bar at the very top with toggles (shelf accent, glyph shape, texture, step verbosity). **That bar is not part of the product** — it exists so the options could be compared side by side. Everything below it is the design.

---

## 1. Read this first — the invariants

These are the rules that are easy to break by accident and expensive to notice later. If a change conflicts with one of these, stop and flag it rather than working around it.

### A1 — Blue means "this triggers a run". Nothing else.

`--accent` is reserved for the run/play buttons. It is deliberately **not** used for the active nav tab, the active view pill, the `SEQ` tag, or branch names (the current app colours branch names blue — that goes away). Active states use ink weight and a neutral wash instead.

The one carve-out: `--accent-tint` as a selection background on list rows (namespace list, key rows) and `--accent` as a 2px selection border there. That's selection, not action, and it never appears on the Views page.

### A2 — Green and red belong to status. Never reuse them.

`--status-good` / `--status-bad` / `--status-warn` are the only greens, reds and ambers in the product. The shelf accent palette (blue, violet, aqua, orange, magenta, slate) and the config value-type palette exclude green and red entirely, so a themed shelf can never be misread as a passing or failing one. Do not add green or red to either palette, even on request — propose slate or aqua instead.

### A3 — One gutter. Cards inside a shelf don't use it.

`--gutter` (20px) separates shelves from each other and shelf rows from each other. Cards **inside** a shelf have no gutter and no border of their own — they're divided by a shared hairline. This is what makes a shelf read as one object at the same spacing as the grid. See §4 for the mechanism.

### A4 — Status is an icon plus a tooltip, never a bare colour and never a text pill.

The card status is a 17px glyph: filled green rounded-square + check, filled red + cross, outlined amber + arc. The word ("Succeeded" / "Failed" / "Running") goes in `title=` and `aria-label=`, not on screen. Colour alone must never be the only carrier — the glyph shape differs per state, so it survives colourblindness and greyscale.

### A5 — Texture only on planes with no text on them.

Two textures exist: a dot grid on the board canvas (behind shelves, never behind content) and a 45° hatch on the "+ add pipeline" drop rail. Do not extend texture to card bodies, run rows, shelf headers, or table rows. Texture that encodes something reads as craft; texture behind 11px type reads as noise and costs legibility.

### A6 — Dark mode is authored, not derived.

The dark values in `launchpad-tokens.css` are chosen for the dark surface, not computed by inverting the light ones. Notably `--shadow-card` is `none` in dark (elevation reads as a lighter surface instead), and the accent, status and hue ramps all shift. If you add a token, add both values by hand.

---

## 2. What changes, page by page

### 2.1 Global chrome

- **Import + Export merge into one "Transfer" button** in the top-right with a dropdown: *Import configuration…*, *Export current view*, and a disabled *Export all views* placeholder.
- **Settings gear** (top-right, beside Transfer) opens a menu whose first section is a Light/Dark toggle. This is the only theme control.
- **Nav tabs keep their text labels** and gain a 14px monochrome SVG icon that inherits `currentColor`. Do not substitute emoji — emoji are rendered by the OS emoji font, so they can't recolour for dark mode and render differently per platform.
- **Nav active state** is ink-coloured text + a 2px bottom border in `--ink-primary`. Not blue (A1).
- **Sidebar toggle** sits at the left of the view bar and opens a 258px pipeline drawer: search field, pipelines grouped by service, each row draggable onto a shelf.

> **Superseded by `DESIGN_SPEC_SEQUENCES.md` §1 and §4.** The nav tab list drops `Sequences` (it folds into Views), and the sidebar drawer becomes a two-tab library — `Pipelines` and `Sequences` — at 266px. Read that addendum before touching nav or the drawer. Everything else in this section still stands.

### 2.2 Views page — shelves

- All shelves in a row are the **same height** (`align-items: stretch` on `.shelf-row`). Card footers still pin to the bottom of their own card via `margin-top: auto`.
- **Shelf accent** is a per-shelf property (`--shelf-accent`), set from a swatch picker in the shelf `⋯` menu. Two presentation modes, both shipping, selected by a user preference: **rail** (3px stripe across the shelf's top edge) and **tint** (8% accent wash on the header band, title at 55% mix). The preference should allow rail, tint, both, or none.
- **Health pill** in the shelf header: `1 failing` / `1 running`, shown only when the shelf contains a non-passing pipeline. Suppressed when everything is green — an all-clear shelf should be quiet.
- Every shelf ends with a **slim 46px "+" drop rail** for adding a pipeline.

### 2.3 Views page — cards

- **Borderless**, divided by hairlines (§4).
- **Card title** 14.5px/600. The `SEQ` tag stays for sequences.
- **`✕` moves to the top-right**, beside the status glyph, at matching visual weight; it tints red on hover. **`⋯` moves down to the footer**, right-aligned, where `✕` used to be.
- **Project label ("Sportsteam") is removed by default.** It becomes a per-card opt-in: a *Show project label* checkbox in the `⋯` menu. Persist this per card.
- **Run buttons are icon-only** — a single play glyph, no "Run" / "Run sequence" text. Sequence cards get the solid variant, single-pipeline cards get the ghost variant. Same accent, two weights.
- **Run rows are single-line**: dot, branch, then duration + relative time as one muted `1m 3s · 4h` string. Branch shows **only the segment after the last `/`** (`feature/bonus-eligibility` → `bonus-eligibility`), with the full ref in `title=`. Branch names are ink-coloured, not blue (A1).
- **Sequence steps** show a short display name with the full step name in `title=`. This assumes the planned per-step rename feature; until that ships, derive a short name by stripping the shared service prefix. Collapse past 4 steps behind a `+N more` toggle so one long sequence can't drive the height of every card in its row.

### 2.4 Configurations page — rebuilt

The current page is one narrow centred box with a nested scrollbar, an inline-expanding tree that reflows the list you're scrolling, and a modal that covers the list you were comparing against. Replace with three panes:

| Pane | Width | Contents |
|---|---|---|
| Namespaces | 258px | Env pills (Dev/Test/Prod), env-coloured endpoint strip, filter field, namespace list with count badges |
| Keys | fill | Header with namespace name + count, key filter, refresh; sticky-header table of Key / Label / Value preview / Type |
| Detail | 470px, slides in | Key path, Copy button, close; syntax-highlighted JSON |

Colour here is functional, not decorative:

- **Environment identity** — Dev/Test/Prod each have a hue, and the endpoint strip carries the active one as a left border and background tint. "Which environment am I about to edit?" becomes answerable peripherally. Prod is orange, not red (A2).
- **Value-type badges** — JSON / BOOL / INT / STR, each a hue, so you can skim a namespace for the one JSON blob among the scalars.
- **Key-count badges** — a single-hue blue ramp in four steps, so Importer (264) reads visibly heavier than Flexicut (8).
- **JSON pane** — keys, numbers and strings coloured separately.

One scroll context per pane. No modal. No nested scrollbars.

> **The Keys and Detail rows above are superseded by `DESIGN_SPEC_CONFIG_LABELS.md`.** The keys table becomes one row per *key* (not per key+label), with a label count and a drift marker in place of the Label column; the detail pane widens to 520px and stacks one collapsible section per label. Read that addendum before touching either pane. Everything else in this section — the namespace pane, environment identity, value-type badges, the key-count ramp — still stands.

---

## 3. Removed / replaced

| Current | Becomes |
|---|---|
| Separate `Import` and `Export` links | One `Transfer` dropdown |
| `● Succeeded` text pill on every card | 17px status glyph + tooltip |
| `▶ Run` / `▶ Run sequence` text buttons | Icon-only play button, solid vs ghost |
| `Sportsteam` under every card title | Hidden; per-card `⋯` opt-in |
| Blue branch names | `--ink-primary` |
| `✕` in card footer | `✕` top-right; `⋯` takes the footer slot |
| Config tree with inline expand + modal | Three-pane master → keys → detail |
| Full branch refs (`feature/…`) | Last path segment, full ref in `title=` |

---

## 4. The hairline grid — implement exactly this

The card divider has to work in **both** directions, because shelves are vertically and horizontally resizable and cards must stack cleanly when a shelf narrows.

```css
.shelf        { overflow: hidden; }              /* clips the overhang */
.shelf-body   { display: flex; flex-wrap: wrap;
                align-content: flex-start;
                margin: 0 -1px -1px 0; }         /* pulls back the trailing lines */
.card         { flex: 1 1 236px; min-width: 236px;
                border-right:  1px solid var(--border-hairline);
                border-bottom: 1px solid var(--border-hairline); }
```

Why each piece matters:

- `flex-wrap: wrap` is what lets cards stack when the shelf narrows.
- `flex: 1 1 236px` (grow allowed) means a lone card on a wrapped row **stretches to fill** rather than leaving a stray hanging divider.
- Every card carries right *and* bottom hairlines, so wrapping produces horizontal dividers with no extra code.
- The negative margin + `overflow: hidden` hides the trailing right/bottom lines at the shelf edge.

Do not reach for `gap` + a background-coloured container to fake the dividers — an uneven final row leaves a visible block of divider colour.

---

## 5. Suggested implementation order

Small, independently reviewable steps. Each should be visually verifiable on its own.

1. **Tokens.** Land `launchpad-tokens.css`, wire `[data-theme]`, move the existing theme switch onto it. Nothing else changes visually yet. Biggest step; everything after depends on it.
2. **Global chrome.** Transfer button, settings menu, nav icons, nav active state, sidebar drawer.
3. **Card internals.** Status glyphs, `✕`/`⋯` swap, icon-only run buttons, single-line run rows with branch shortening, hidden project label + `⋯` opt-in.
4. **Shelf layout.** Equal-height rows, the hairline grid, wrapping/stacking, the `+` drop rail.
5. **Shelf theming.** `--shelf-accent`, the swatch picker, rail/tint preference, health pills.
6. **Configurations page.** The three-pane rebuild — self-contained, can run in parallel with 2–5.
7. **Texture.** Dot grid and hatch. Last, because it's the easiest thing to over-apply.

---

## 6. Acceptance checks

- [ ] Every shelf in a row is the same height; card footers still align across a shelf.
- [ ] Narrow a shelf to one card wide: cards stack, dividers become horizontal, no stray vertical line, no gap where a border used to be.
- [ ] `--accent` appears **only** on run buttons and list-selection states. Grep the stylesheet to confirm.
- [ ] No green or red outside the three `--status-*` tokens.
- [ ] Toggle dark mode on both pages: no unreadable text, no light-mode shadow bleeding through, JSON highlighting still legible.
- [ ] Every status glyph has a `title` and `aria-label` carrying the state word.
- [ ] Greyscale the page (devtools → Rendering → emulate achromatopsia): pass/fail/running still distinguishable by glyph shape.
- [ ] Configurations: one scrollbar per pane, no modal, detail pane opens without losing your place in the key list.
- [ ] A shelf where everything passes shows no health pill.
- [ ] Branch names show the last path segment; full ref appears on hover.

---

## 7. Open questions for the implementer

- **Step renaming.** §2.3 assumes per-step display names. If that feature isn't in yet, the prefix-stripping fallback is fine for now — but flag it rather than shipping verbose names, since the short names are what make the sequence cards fit.
- **Accent persistence.** Shelf accent and the per-card project-label toggle both need somewhere to live in the view config. Check whether the existing view export/import schema round-trips unknown fields, or whether it needs a version bump.
- **Glyph shape.** The mockup ships rounded squares with a circle variant behind a toggle (`--r-glyph`: `4.5px` vs `8px`). Confirm the final call before removing the variable.

**Decided (2026-08-15):**

- *Step renaming* — resolved by implementation: steps carry an explicit `Alias` (`SequenceStepDto.Alias`), which the cards render with `Name` as the fallback.
- *Accent persistence* — the export/import schema will preserve unknown fields via `[JsonExtensionData]` on the config document, so new view properties (shelf accent, the project-label toggle) round-trip without a version bump and an older Launchpad importing a newer file keeps the data instead of silently dropping it. Not yet implemented.
- *Glyph shape* — rounded squares stay (`--r-glyph: 4.5px`). Keep the variable: it costs nothing, and tokens carrying their variants is the same posture A6 takes for dark values.
