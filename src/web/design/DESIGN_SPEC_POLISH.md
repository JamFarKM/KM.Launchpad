# Visual polish — implementation spec
### Addendum to DESIGN_SPEC.md

**Status:** approved, ready to implement
**Scope:** micro-typography, truncation, iconography, motion, focus and empty states. **No changes** to the colour system, the card or shelf geometry, the diff rendering, or the token palette — every proposal here reuses existing tokens.
**Companion files:**

| File | What it is |
|---|---|
| `polish-mockups-v1.html` | Interactive reference. Every proposal below is shown beside the current treatment at real size, with real DEV Deployment data. Open it in a browser. |
| `truncate.js` | The text-fitting utility referenced throughout §1. Tested, no dependencies. Drop it in. |

The mockup's black bar at the top — theme and focus-ring toggles — **is not part of the product**. It exists to compare states.

---

## 0. Why this is one document

These are individually small changes, but they share one cause. The app's system-level design is done: tokens, dark mode, the diff, the hairline grids, the accent discipline. What's left is the **10–12px layer**, which is where this app actually lives — dense cards, four-row run lists, monospace paths — and it's where the current build is weakest.

The single largest contributor is truncation. Roughly two thirds of visible text is currently cut off, and most of it is cut off in the way that destroys the most information.

---

## 1. Truncation

### 1.1 Middle-truncate identifiers, never tail-truncate

**The rule:** for any string whose distinguishing part is at the end — branch names, file paths, pipeline names — truncate the **middle**.

Current build, four rows on one card:

```
acca-bonus-lad…    1m 17s · 18h
acca-bonus-lad…    1m 25s · 18h
acca-bonus-lad…    1m 27s · 19h
acca-bonus-lad…    1m 28s · 19h
```

Four different branches, same prefix, rendered identically. Middle-truncated:

```
acca-…er-switch    1m 32s · 57m
acca-…r-rollback   1m 24s · 18h
acca-…der-hotfix   1m 25s · 18h
acca-…der-revert   1m 49s · 19h
```

Use `truncate.js`. Apply to: run-row branch names, the Review file tree's folder paths, drawer pipeline names, and card titles where they overflow.

### 1.2 Measure the budget — do not guess it

**This is the part that goes wrong.** A guessed character count leaves CSS `text-overflow: ellipsis` to clip the result a second time, producing `acca-bon…r-sw…` — worse than the original. I hit exactly this while building the mockup.

`fitElement()` measures the element's real `clientWidth` with a canvas `measureText`, binary-searches the largest fitting budget, and adds `is-fitted` so the element can switch to `text-overflow: clip`.

```css
[data-truncate] {
  display: block;            /* REQUIRED — inline elements have no width */
  min-width: 0;              /* REQUIRED when it is a flex child */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;   /* fallback before JS runs */
}
[data-truncate].is-fitted {
  text-overflow: clip;       /* REQUIRED — stops the double ellipsis */
}
```

Two failure modes the module guards against, both worth knowing:

- **`display: inline`** has no measurable width, so nothing truncates and the raw string renders. `fitElement` logs a one-time console warning rather than failing silently.
- **Width changes without a window resize** — a shelf being resized, a side panel collapsing. `autoFit()` uses a `ResizeObserver` debounced to one frame, not a window listener.

`headRatio` defaults to `0.34`, biasing the visible characters toward the tail. Use `0.5` for drawer pipeline names, where the head carries real meaning (`SB.OfferIntegration…`).

### 1.3 Group consecutive runs that share a branch

Independent of 1.1 and a bigger win on real data, where all four runs on a card usually share one branch. State the branch once; let the rows carry only timings.

```
acca-bonus-ladder-switch  ×4        ← full name, its own line, 11.5px/600 --ink-secondary
  ● 1m 17s                    18h
  ● 1m 25s                    18h
  ● 1m 27s                    19h
  ● 1m 28s                    19h
```

- Group **consecutive** runs only (`groupConsecutive` in `truncate.js`). Run history is chronological; merging non-adjacent groups would misrepresent the timeline.
- The group heading gets the full branch name, middle-truncated only if it still overflows at full card width.
- Rows become `duration` (left, `--ink-secondary`) and `relative time` (right, `--ink-muted`), both tabular.
- A single-run group renders as one heading plus one row — do not special-case it away; consistency beats compactness here.

This composes with 1.1: group first, middle-truncate the heading if needed.

### 1.4 Never truncate a unit

`20h a…` must degrade to `20h`, never to a cut word. Use `relativeShort()` / `durationShort()` from `truncate.js` — both produce strings short enough that truncation never applies, and `relativeShort` falls back to an absolute date past 30 days rather than growing unboundedly.

### 1.5 Break paths on separators, not mid-word

The Review file tree currently renders `SA.Phase1.Migrations/SA.Phase1.Migration s/Scripts/tps-user` — `word-break: break-all` splitting "Migrations".

Preferred: single line, middle-truncated, full path in `title`. If the path must wrap, use `word-break: break-word` with `<wbr>` inserted after each `/`.

### 1.6 Let containers earn their width

`Configuration Registry` renders as `Configurati…` in a shelf header with room to spare, because the title competes with `⋯`, `✕` and the overflow badge for a fixed share.

```css
.shelf-header .title { flex: 1; min-width: 0; }
.shelf-header .controls { flex-shrink: 0; }
```

Audit every truncating container for this before adding truncation logic to it — some of the current truncation is a layout bug, not a content-length problem.

---

## 2. The logs button

**Decision: use the word.** Replace the binoculars icon with `LOGS` — 11px, weight 700, `0.04em` tracking, in the existing `--ink-secondary` outline button.

Detail dies below roughly 16px. Two enclosed circles with an internal gap is past that limit, and at 12px the current icon reads as `6ᐤ` or a rendering fault. It appears on every card, which makes it the most-repeated unclear element in the product. Four characters cannot be misread and the footer has the room.

*(If the row ever needs to be tighter, the fallback is a document-with-lines glyph — one enclosed area, survives 12px. The mockup shows both. Text is the decision.)*

---

## 3. Motion

The app has essentially no motion, and that is correct almost everywhere. Two exceptions.

### 3.1 The running state breathes

It is the only genuinely live state in the product; a static ring reads as a screenshot of something that *was* running.

- Status glyph: rotate the amber arc, **1.8s linear infinite**.
- The running run-row's dot: opacity pulse `1 → 0.45 → 1`, **1.6s ease-in-out infinite**.

```css
@keyframes spin    { to { transform: rotate(360deg) } }
@keyframes breathe { 0%,100% { opacity: 1 } 50% { opacity: .45 } }

.status-glyph.is-running svg { animation: spin 1.8s linear infinite; transform-origin: 50% 50% }
.run-row .dot.is-running     { animation: breathe 1.6s ease-in-out infinite }

@media (prefers-reduced-motion: reduce) {
  .status-glyph.is-running svg,
  .run-row .dot.is-running { animation: none }
}
```

Deliberately slow. Anything faster nags in peripheral vision on a dashboard someone leaves open all day.

### 3.2 Things that appear, fade in

Menus, the sequence editor panel, the config detail pane: **120–150ms** opacity plus a 4px translate. Instant appearance is what makes an interface feel like a series of states rather than one continuous thing.

**Nothing else animates.** In particular: no hover transitions on cards, no shelf reflow animation, no run-row transitions.

---

## 4. Sequence steps look inert but are buttons

Clicking a step opens its logs. They currently render as static bullets, so the feature is undiscoverable.

On hover: `--hover-wash` background, text promoted from `--ink-secondary` to `--ink-primary`, `cursor: pointer`, and a right-aligned `logs` hint at 9.5px/700 in `--ink-muted`.

No new controls — an existing feature becomes findable.

---

## 5. Keyboard focus

Nothing is focus-styled today. Given the density of small controls this is both an accessibility requirement and a polish win.

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 7px;
}
```

Use `:focus-visible`, **not** `:focus` — it must appear for keyboard users and never on a mouse click. This is the one sanctioned use of `--accent` outside A1's action rule; it is a browser-state affordance, not a control colour.

---

## 6. Empty states

Every list needs one. The drawer currently renders a **completely blank panel** when a search matches nothing.

Name the term and the scope, and offer the escape:

> **No pipelines match "Placement"**
> in project **Account**
> `Search all projects →`

Naming the scope matters here specifically: the usual fix is switching project, and the user can't tell that from a blank panel.

Apply the same pattern to the key filter on Configurations and the PR filter on Review.

---

## 7. Drawer overflow

A 720-pipeline project produces a **horizontal scrollbar** in the drawer, because long names overflow instead of truncating. Horizontal scroll inside a vertical list is always wrong.

Middle-truncate at `headRatio: 0.5`, full name in `title`.

---

## 8. Shelf accent picker

Four problems: no heading, no indication of the current value, seven swatches wrapping 5+2, and a "none" option that reads as white.

- One row of seven at 22px — fits the 214px menu width exactly (`grid-template-columns: repeat(7, 1fr); gap: 6px`).
- A `SHELF ACCENT` label above, matching the settings menu's section labels.
- **The current value gets a ring:** `box-shadow: 0 0 0 2px var(--bg-surface), 0 0 0 4px var(--ink-primary)`.
- Swatches become **rounded squares** (7px), matching the status glyph and type badges. Circles are the odd shape out in this system.
- "none" gets a dashed border and a diagonal slash, not a white fill.

---

## 9. Odds and ends

**Native `<select>` → custom control.** The project picker is the only OS-styled control in the app; it won't follow the dark theme reliably and it sits at the top of the most-used panel. Match the Review page's `PROJ`/`REPO` picker: prefix label, value at weight 600, chevron.

**Tabular figures everywhere numbers stack.** Durations, timestamps, label counts, key counts, `+45 −1`. Some sites have `font-variant-numeric: tabular-nums`, some don't. `1m 3s` above `1m 29s` above `52s` only looks tidy when the digits align.

**Widen the type scale.** Hierarchy is currently carried almost entirely by weight and colour, which is why dense areas read flat. Push run-row metadata down to 10.5px `--ink-muted`; take card titles up to 15px. Widening the ratio between loudest and quietest text is the cheapest way to make a dense card feel organised.

**Review minimap.** Currently a saturated green bar beside a deliberately calm diff. Take it to `--diff-add-stripe` / `--diff-del-stripe` at 55% opacity, and show deletions as well as additions.

**Shelf names that collide with app concepts.** A shelf called `Pipelines` in the PROD view collides with the drawer's `Pipelines` tab; `Test` reads as an environment. Naming, not styling — but worth a rename.

---

## 10. What not to change

Stated explicitly because polish work sprawls.

- **The colour system is finished.** Do not add hues.
- **Card and shelf geometry is right.** Widths, padding, the hairline divider grid — leave them.
- **The dark-mode diff is good.** Do not touch the tint/stripe balance or the syntax palette.
- **The dot-grid texture is at the correct strength.** It would be easy to nudge it up and immediately make the canvas noisy.
- **The run rows' restraint is correct** — no borders, no zebra striping, just hairlines. That restraint is exactly *why* fixing truncation pays off so visibly.

---

## 11. Implementation order

1. **`truncate.js` + the required CSS** (§1.2). No visual change yet; land the utility and its tests.
2. **Run-row branch truncation** (§1.1) — the single most visible change in the app.
3. **Time and duration formatters** (§1.4) — small, and they remove a class of truncation entirely.
4. **Run-row grouping** (§1.3) — needs 2 and 3 in place.
5. **The logs button** (§2).
6. **Focus ring** (§5) and **step hover** (§4) — independent, ship together.
7. **Running-state motion** (§3.1) and **fade-in** (§3.2).
8. **Empty states** (§6) and **drawer overflow** (§7).
9. **Accent picker** (§8).
10. **§9 odds and ends** — each independent; tabular figures first, it's the cheapest.
11. **§1.5 and §1.6** — path breaking and container widths, as you touch those components.

Stop for review after step 2. It changes the look of the busiest screen in the app and is worth a look before the rest lands on top of it.

---

## 12. Acceptance checks

- [ ] No run row shows a tail-truncated branch. Four runs on different branches sharing a prefix are individually identifiable.
- [ ] No element shows a double ellipsis (`acca-bon…r-sw…`). Grep for `is-fitted` and confirm those elements are `text-overflow: clip`.
- [ ] Resize a shelf narrower: branch names re-fit without a page reload or window resize.
- [ ] Collapse a Review side panel: the file-tree paths re-fit.
- [ ] Every truncated element has a `title` with the full value.
- [ ] No relative time or duration is ever clipped mid-unit.
- [ ] A card whose four runs share a branch shows the branch once at full length.
- [ ] `Configuration Registry` fits its shelf header without truncating.
- [ ] Tab through a card: run button, logs, `⋯`, `✕` all show a visible focus ring. Click them with a mouse: no ring appears.
- [ ] Hovering a sequence step shows a background, promotes the text, and reveals the `logs` hint.
- [ ] With `prefers-reduced-motion: reduce` set, nothing animates — including the running glyph.
- [ ] Search the drawer for a term with no matches: a message naming the term and the project appears, with a way out.
- [ ] Switch the drawer to a 700+ pipeline project: no horizontal scrollbar.
- [ ] Open the shelf accent menu: the current accent is visibly marked, seven swatches in one row, "none" is not a white circle.
- [ ] Dark mode: every change above still reads. Check the focus ring against `--bg-surface-2` in particular.
- [ ] Grep the diff CSS and the token file: unchanged by this work.
