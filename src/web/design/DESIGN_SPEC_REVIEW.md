# Review page — design spec (addendum to DESIGN_SPEC.md)

**Status:** approved mockup, ready to implement
**Scope:** presentation only for the existing Review page. No Azure DevOps API changes beyond the extra PR-list fields noted in §7.
**Reference files (commit alongside this doc):**

| File | What it is |
|---|---|
| `src/web/design/review-page-redesign-v1.html` | Interactive mockup. Ground truth for anything this doc doesn't pin down. |
| `src/web/design/DESIGN_SPEC.md` | The parent spec. Invariants A1–A6 still apply except where amended in §1 below. |
| `src/web/design/launchpad-tokens.css` | Existing tokens. This page adds the new ones listed in §2. |

The mockup's black harness bar at the top — the PR switcher and the "What changed?" button — **is not part of the product**. It exists so the three states (mixed diff / all-additions / nothing selected) can be compared. Everything below it is the design.

---

## 1. Amendment to invariant A2

The parent spec says green and red are reserved for `--status-*` and must never be reused. The Review page needs one documented carve-out:

> **A2 carve-out — the diff body.** Inside a diff, green means *added* and red means *removed*. This convention is too strong to break and the diff canvas is a context where nothing else competes for those hues. The carve-out is limited to: diff row tints, diff gutter stripes, word-level highlights, the `+`/`−` signs, the `+n/−n` counts in the toolbar, and the change minimap.
>
> It does **not** extend to file-type badges, PR-list flags, or anything in the page chrome. Those are *identity*, not health, and must use the identity hues (§2).

Two consequences for the current build:

- The `A`/`E` file badges in the right rail currently use status green and accent blue. **Change to the `--ft-*` identity hues** (aqua / violet / slate). Green-A beside blue-E currently reads like a pass/fail signal.
- Vote buttons: Approve **may** use `--status-good` as a solid fill, because "approve" genuinely is a good/bad axis and it is a single button, not a palette. Reject uses a red *hover* tint only, never a solid red fill — a permanently-red destructive button in the primary position invites misclicks.

**A1 is unchanged.** Accent blue continues to mean action: the gutter `+` comment button and the Comment submit button both qualify. The `E` badge does not, and moves off accent under the change above.

---

## 2. New tokens

Add to `launchpad-tokens.css`. Every value has both a light and a dark authored value (invariant A6).

```css
[data-theme="light"] {
  /* diff surfaces — row tint is faint by design; the gutter stripe carries
     identification, so a whole-file addition is never a solid slab of colour */
  --diff-gutter:    #f6f6f3;
  --diff-add-tint:  color-mix(in oklab, var(--status-good) 10%, var(--code-bg));
  --diff-add-stripe:#0a8a0a;
  --diff-add-word:  color-mix(in oklab, var(--status-good) 26%, var(--code-bg));
  --diff-del-tint:  color-mix(in oklab, var(--status-bad)  9%, var(--code-bg));
  --diff-del-stripe:#c23434;
  --diff-del-word:  color-mix(in oklab, var(--status-bad) 24%, var(--code-bg));

  /* syntax — contains NO green and NO red (see §3) */
  --syn-keyword:#1c5cab; --syn-type:#0d7b8a; --syn-string:#a35a12;
  --syn-number:#5d4bb8;  --syn-comment:#8b8a84; --syn-punct:#52514e;

  /* file change type — identity, not health */
  --ft-add:#1097a8; --ft-mod:#6b5bd6; --ft-del:#5c6672;

  --code-size:12px;   /* user-adjustable, see §5 */
}

[data-theme="dark"] {
  --code-bg:        #161615;   /* slightly lifted off --bg-surface */
  --diff-gutter:    #1c1c1b;
  --diff-add-tint:  color-mix(in oklab, var(--status-good) 13%, var(--code-bg));
  --diff-add-stripe:#2b9e2b;
  --diff-add-word:  color-mix(in oklab, var(--status-good) 30%, var(--code-bg));
  --diff-del-tint:  color-mix(in oklab, var(--status-bad)  14%, var(--code-bg));
  --diff-del-stripe:#c95e5e;
  --diff-del-word:  color-mix(in oklab, var(--status-bad)  30%, var(--code-bg));

  --syn-keyword:#6da7ec; --syn-type:#35b3c4; --syn-string:#e0a86a;
  --syn-number:#b3a6f0;  --syn-comment:#8b8a84; --syn-punct:#c3c2b7;

  --ft-add:#35b3c4; --ft-mod:#9085e9; --ft-del:#8b95a3;
}
```

---

## 3. Diff legibility — the four moves

The current dark-mode diff turns a fully-added file into one solid green block with the code floating on top, and the line numbers sit at very low contrast over that green. Four changes fix it, and they work together — don't cherry-pick.

**1. Faint tint, strong stripe.** Drop the row background to ~10–13% of the status hue mixed into the code surface, and add a **2px inset stripe** on the leading edge of the code cell in a stronger step of that hue. The stripe is what makes the row unmistakably an addition, which is what frees the background to be quiet.

```css
tr.add .code { background: var(--diff-add-tint); box-shadow: inset 2px 0 0 var(--diff-add-stripe); }
tr.del .code { background: var(--diff-del-tint); box-shadow: inset 2px 0 0 var(--diff-del-stripe); }
```

**2. The gutter never tints.** Line-number cells keep `--diff-gutter` regardless of row type. This single change fixes the contrast problem — the numbers stop competing with a coloured background. The `+`/`−` sign column *does* take the stripe colour as its text colour, at weight 700.

**3. A syntax palette with no green and no red.** This is the important one. The diff tint owns those two hues, so nothing in the code may use them — otherwise a green string on a green added row is unreadable, which is what happens today. Keywords are blue, types aqua, strings warm sand, numbers violet, punctuation secondary ink.

**4. Comments are neutral grey, not green.** On the MigrationService diff most of the added block is commented-out code, and green-italic on green-tint is the single worst-reading thing on the page. `--syn-comment` is `#8b8a84` in both modes — it has enough contrast on both the plain and the tinted surface.

**Word-level diff.** On a paired del/add, highlight only the changed tokens at `--diff-*-word` (~26–30% mix). See `MigrationService.cs` lines 202/204 in the mockup, where only `cs` → `connectionString` is marked.

**The empty side of a side-by-side pair** keeps the 45° hatch it already has — that's a non-content plane and exactly the case invariant A5 allows. Note the specificity trap: `td.void` must beat `tr.add .code`, or a one-sided change tints the empty pane green.

```css
td.void, tr.add td.void, tr.del td.void {
  background: repeating-linear-gradient(45deg, transparent 0 5px, var(--hatch) 5px 6px);
  box-shadow: none;
}
```

---

## 4. Auto-inline for one-sided files

When a file is 100% additions or 100% deletions, side-by-side leaves one pane empty and squeezes the code into half the width. Open those files in **Inline** instead.

- Predicate: `(add > 0 && del === 0) || (del > 0 && add === 0)`.
- Show a small aqua chip beside the toggle — `all additions · inline` — with a `title` explaining why and that the toggle overrides. Never silently change a mode the user can see a control for.
- The moment the user touches the Side by side / Inline toggle, set a `viewLocked` flag and stop auto-selecting **for the rest of the session**. Reset it when the selected file changes.
- The chip renders only while the auto-choice is actually in effect.

---

## 5. Layout and chrome

### Collapsible side panels

Both side panels collapse, driven by `data-left` / `data-right` on the grid container so the transition is a single `grid-template-columns` animation:

```css
.review { display:grid; grid-template-columns: var(--w-left,264px) minmax(0,1fr) var(--w-right,276px);
          transition: grid-template-columns .16s ease; }
.review[data-left="off"]  { --w-left:0px; }
.review[data-right="off"] { --w-right:0px; }
```

Put both toggles **in the diff toolbar** — left-most and right-most — so they're always reachable regardless of which panel is hidden. They take the `.iconbtn.on` accent-tint state while their panel is visible. Collapsing both is the intended way to read a wide side-by-side diff; the mockup's collapsed state is the best demonstration of why this matters.

### Where the agent panel lives — the left column's second tab

**Amended after building the dock this section used to describe.** `DESIGN_SPEC_CONNECTORS.md` describes *what* lives in the connector panel; this is *where* it lives, and it has now been wrong twice, so the reasoning matters more than the conclusion.

The reasoning has been stable throughout. Two of the three panes are not equally dispensable:

- The **PR list** genuinely is never needed at the same time as the agent. You pick a pull request, then you are done with that list.
- The **file tree** is needed *constantly* alongside the agent, because a citation or a follow-up routinely points at a file other than the one currently open.

The first design put the chat in a second tab on the **right rail**, sharing space with the file tree — which broke exactly the combination that matters. The second design moved it to a **bottom dock** spanning the diff and the file tree. That fixed the simultaneity problem, and introduced two others: the conversation and the diff then compete for *height*, which is the axis a diff can least afford to lose, and a full-width dock gives a chat column far more width than prose can use while the diff gets less height than code can use.

**The current design applies the same reasoning to the pane that was always the dispensable one.** The left column carries two tabs — `Pull requests` and the connector's name — and the conversation replaces the list when selected. Three columns, one row:

```css
.review {
  display: grid;
  grid-template-columns: var(--w-left,340px) minmax(0,1fr) var(--w-right,380px);
  grid-template-areas: "prlist diff files";
}
.review[data-left="off"]  { --w-left: 0px !important; }
.review[data-right="off"] { --w-right: 0px !important; }
```

- **The file tree keeps its own column**, which is the requirement that ruled out the rail tab and is now satisfied without costing the diff any height.
- **Horizontally resizable**, with a drag handle on the left panel's right edge. Wider bounds than the file rail's (280–900px against 320–900): a PR list is legible at 340px and a conversation is cramped there, so the reviewer has to be able to push it well past the width the list alone would want. Persisted across sessions, not just the session — how much of the window goes to conversation is a preference, not a per-visit accident.
- **Both tab bodies stay mounted**, hidden with `display`. The PR list keeps its scroll position and its filter, and the conversation keeps a part-typed question, across any number of switches.
- **The agent tab is disabled, not hidden, with no pull request open.** A tab that appears and disappears as you click around is harder to find than one that is visibly waiting for something.
- **No third toolbar toggle.** The existing left-panel toggle already hides the whole column, tabs included, which is the "read a wide diff uninterrupted" move — and there is no separate collapsed state to design, because switching back to `Pull requests` is the way you stop looking at the conversation.
- **The 44px identity strip is gone with the dock**, and with it the argument for it: the outage banner and the `CACHED` tag now live inside the panel, where the conversation they qualify is. The cost is real and worth stating — with the `Pull requests` tab selected, an outage is not visible until you switch. If that turns out to matter, the fix is a marker on the tab itself, not a permanently-visible strip.

### Context bar

Merge the `STARRED` row into the project/repository picker row — it currently spends a full row on one chip. Order: `[Proj ▾] [Repo ▾] [★] │ STARRED  chip  chip`.

The pickers gain a small uppercase `PROJ` / `REPO` prefix inside the control and a `title`. This is **not** because the duplicate "Account" was a labelling bug — it's a genuine name collision — but the prefix costs nothing and removes the ambiguity when it recurs.

### Vote bar

`Approve` solid (`--status-good`) · `With suggestions` outline · `Waiting for author` outline · divider · `Reject` outline with a red hover tint. All four get a 12px icon so they're scannable without reading. "Approve with suggestions" shortens to "With suggestions" — the row is already the widest thing on the page.

### Toolbar view options

A `⋯` menu holding **Wrap long lines** (toggles `data-wrap` on the root; `.code { white-space: pre-wrap; word-break: break-word }`) and a **code size** segmented control writing `--code-size` at 11 / 12 / 13px. Long lines currently clip with no indication that anything is missing.

The `Side by side / Inline` segmented control needs a **visible** selected state — a raised surface-coloured pill with a hairline shadow in light, `--border-strong` fill in dark. The current version is nearly invisible.

### Collapsed-lines row

One row spanning **both** panes (`colspan=6` in side-by-side, `4` inline) — it's currently duplicated per pane. Contents: expand-up 25 · expand-all *n* · expand-down 25 · `n unchanged lines hidden`. The current icon renders as a **snowflake**; use a chevron.

---

## 6. Comment composer

Confirmed decision: **the composer stays an overlay.** Inserting a row would reflow a long diff and read as a jump. The fix is to make the overlay look deliberate rather than like a rendering fault:

- Elevated card: `--shadow-pop`, `--border-strong`, 10px radius, on `--bg-surface` (not the code surface).
- A small rotated square pointing at the line it belongs to, so the anchor is unambiguous.
- A **scrim** over the lines it covers: `background: var(--code-bg); opacity: .62; pointer-events: none`. This is the piece that changes the read — covered code looks intentionally dimmed rather than accidentally hidden.
- `Comment` is a real primary button (`--accent`, white text). It currently reads as disabled. `Cancel` is a proper outline button, not bare text.
- Footer hint: `⌘⏎ to post · Esc to dismiss`, and wire both.

---

## 7. Right rail — file tree

The right rail is file-tree only — it does not host a tab for the connector panel. That is the left column's second
tab (§5, "Where the agent panel lives") specifically so the tree stays visible while the connector is in use; see
`DESIGN_SPEC_CONNECTORS.md` §7 for what the panel itself contains.

- **Group by folder.** Collapsible group per directory, path on the folder row in monospace, allowed to wrap to two lines, with a file count. This is what disambiguates the two `001_CreateDB.sql` files — they now sit under visibly different headers — and it means filenames rarely need truncating at all.
- **Truncation by role:** folder paths truncate at the *start* (the tail is what distinguishes them), filenames at the *end*. That asymmetry is correct, not an inconsistency.
- **Viewed checkboxes** per file, plus `n of m viewed` and a thin progress bar in the rail header. Viewed rows dim to 45%. This is the main mechanism for keeping your place in a seven-file review. Persist per (PR, file, source commit) so it resets when the author pushes.
- **File badges** `A` / `M` / `D` on `--ft-*` (§1). Keep the letters — they're a secondary encoding that makes the badges pass the colour-alone test — but give each a `title` with the full word.
- **Not in scope, deferred by request:** per-file `+/−` counts.

## 8. Left rail — PR list

Adds a search field over id / title / author, and per-row metadata: file count, comment count, author, relative date, and `DRAFT` / `CONFLICTS` flags. Flags use `--hue-slate` and `--status-warn` respectively — a merge conflict is a genuine warning state, so `--status-warn` is correct here and not an A2 violation.

All of these come off the existing Azure DevOps PR payload (`reviewers`, `isDraft`, `mergeStatus`, thread count) — confirm each is already fetched before wiring the UI, and hide any field that isn't rather than firing an extra request per row.

## 9. Empty state

**One** message, not two. Today the toolbar says `No file selected` (in monospace, so it reads like a filename) while the body says `No pull request selected`. When no PR is selected: hide the vote bar, the diff toolbar, and the right rail entirely, and show a single centred state in the middle pane with an icon, `No pull request selected`, and one line of guidance. The PR list stays visible — it's the thing the user needs to act on.

---

## 10. Implementation order

1. **Tokens** (§2) — land the diff, syntax and file-type tokens. No behaviour yet.
2. **Diff rendering** (§3) — tint/stripe split, neutral gutter, new syntax palette, `td.void` specificity fix. Biggest visual payoff; verify in dark mode first, since that's where the current problem is.
3. **Toolbar** (§5) — visible segmented state, `⋯` menu with wrap + code size, panel collapse toggles.
4. **Auto-inline** (§4) — needs the toolbar chip from step 3.
5. **File tree** (§7) — folder grouping, then viewed state, then badge recolour.
6. **Chrome** (§5) — context bar merge, vote hierarchy.
7. **Composer** (§6) and **empty state** (§9) — independent, can land any time.
8. **PR list** (§8) — last, because it depends on confirming which API fields are already available.
9. **The agent panel's placement** (§5) — the left column's tabs and its resize handle belong here and can land
   independently of any connector being wired up; what fills the panel is `DESIGN_SPEC_CONNECTORS.md`'s own
   implementation order (§8 there), not this one.

Word-level diff can follow step 2 as its own change; it's the only part needing a diff algorithm rather than styling.

---

## 11. Acceptance checks

- [ ] Dark mode, all-additions file: the page does not read as a solid green block; individual added rows are still unambiguous from the stripe alone.
- [ ] Line numbers are legible on added, deleted and context rows in both themes.
- [ ] Grep the syntax palette: no green, no red.
- [ ] A mostly-commented added block is comfortably readable in dark mode.
- [ ] Side-by-side on a one-sided file: the empty pane shows hatch, **not** a green or red tint.
- [ ] Opening an all-additions file lands in Inline with the chip; touching the toggle stops auto-selection until the file changes.
- [ ] Collapsing both panels gives the diff the full window width and long lines become visible.
- [ ] Wrap toggle actually wraps; code size persists across file selection.
- [ ] The two `001_CreateDB.sql` files are distinguishable at a glance.
- [ ] Marking files viewed updates the count and bar; state survives switching files and back.
- [ ] Collapsed-lines row appears once per hunk, not once per pane, with a chevron and three expand options.
- [ ] Composer: covered code is visibly dimmed, the pointer aims at the right line, Comment does not look disabled, Esc dismisses.
- [ ] No PR selected: exactly one empty message on screen.
- [ ] Greyscale the diff (devtools → Rendering → emulate achromatopsia): additions and deletions are still distinguishable — the `+`/`−` sign column is the fallback, so confirm it's present in both view modes.
- [ ] Switching the left panel to the agent tab and back preserves the PR list's scroll position and filter, and a part-typed question survives the round trip.
- [ ] Dragging the left panel wider takes width from the diff and leaves the file tree's column untouched; the width survives a reload.
- [ ] The file tree stays visible and interactive with the agent tab selected, at both 1280px and 1680px — this is the specific gap that ruled out putting the agent in the right rail, so it's worth checking directly rather than assuming the grid math works.
- [ ] With no pull request open, the agent tab is present and disabled rather than missing.

---

## 12. Open questions

- **Word-level diff algorithm.** The mockup fakes it with a marked substring. Real implementation needs a token-level LCS per line pair; check whether the existing diff already returns character ranges from the Azure DevOps API before writing one.
- **Viewed-state persistence key.** Should include the source commit SHA so it clears on a new push. Confirm the API exposes it on the file entry.
- **Syntax highlighting engine.** The mockup uses a throwaway regex highlighter for C# and SQL only. If the real page already uses a library, re-theme it against §2 rather than replacing it — the requirement is only that the theme contains no green and no red.
- **Minimap.** Kept as-is but recoloured to `--diff-*-stripe` at 55% and now shows deletions too. Worth deciding whether it should also mark comment threads (the mockup has a `.cmt` class in accent blue, unused) — and, now that inline agent annotations exist (`DESIGN_SPEC_CONNECTORS.md` §7.6), whether it should mark those too.
- **Dock height persistence.** Remembered "for the session" is the minimum bar. Worth deciding whether it should persist across sessions (a per-user preference, like the model `<select>` in Settings) or reset each time — leaning toward persisting, but confirm before building storage for it.

**Decided (2026-08-15):**

- *Word-level diff* — resolved by implementation: Monaco's `diffAlgorithm: "advanced"` provides it; no bespoke LCS.
- *Viewed-state key* — resolved by implementation: keyed on `(prId, sourceCommit)`, so it clears on a push.
- *Syntax highlighting* — resolved by implementation: Monaco, re-themed per §2.
- *Minimap* — diff stripes only. No comment-thread or annotation markers: the file tree already carries per-file thread counts, the gutter carries annotation markers, and the mockup's accent-blue `.cmt` class would have violated A1 anyway (a thread marker is not an action). Drop the unused class.
