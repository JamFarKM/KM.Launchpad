# Design spec — the change map

**Status: proposed.** This spec and `change-map-v1.html` are the design; nothing is implemented.
Addendum to `DESIGN_SPEC_CONNECTORS.md` — the map is produced by the same connector machinery as
answers, and every honesty rule in §5.2 applies to it unchanged.

---

## 1. What this is

A pull request diff answers "what lines changed." It is terrible at "what *kind* of thing changed,
and where in the system." A reviewer opening a 30-file PR spends their first minutes building a
mental map — which files are plumbing, which are the domain, whether the change flows top-down or
bottoms out in one model — and that map exists only in their head, rebuilt by every reviewer.

The change map is that mental map, drawn once. The agent groups the PR's changed files by
architectural area, names the layers, draws the dependencies between the groups, and marks the
user-visible flow the change serves. It opens from a button in the agent panel's header and renders
over the diff column as a sheet.

**The model does not draw.** It emits a small typed graph — groups, edges, a flow — in a closed
vocabulary, exactly as §5.2 makes it emit claims rather than prose. Geometry, colour and layout
belong to the client. A model that could place pixels could also place them badly; a model that can
only say `"depth": 0` cannot.

## 2. The shape the agent produces

One completion, same connector, same tool loop (it may read `csproj` files, folder listings or an
architecture doc to ground the classification), same byte and iteration budgets, and a second
schema beside the answer schema:

```jsonc
{
  "style": "clean",              // clean | layers | modules | pipeline | unknown
  "style_basis": "structure",    // structure: folder/project names say so; inferred: judgment
  "groups": [
    {
      "id": "core",
      "name": "Coupon snapshot model",
      "depth": 0,                // 0 = innermost (domain); higher = further out
      "summary": "One sentence on what changed here and why it matters.",
      "files": [{ "path": "…/CouponSnapshot.cs", "added": 6, "removed": 1 }]
    }
  ],
  "edges": [
    { "from": "app", "to": "core", "label": "builds snapshot" },
    // An edge whose `from` is DEEPER than its `to` points outward. Under clean/layers rules that
    // is a dependency violation, and the client draws it as a warning — see §5.
  ],
  "flow": [
    { "step": 1, "group": "api", "action": "Placement request arrives" }
  ]
}
```

Caps, in the schema and enforced again by the parser exactly as `MaxSegments`/`MaxCitations` are:
**8 groups, 14 edges, 6 flow steps.** A map with forty nodes is the diff again, with worse
typography. If the PR genuinely cannot be told in 8 groups, the agent is instructed to group
coarser, never to truncate silently.

**No invented paths.** Every `files[].path` is validated against the PR's changed files plus the
paths the agent actually read — the same `citablePaths` rule and the same resolver §5.2 already
applies to citations. A group whose every path fails validation is dropped; a map whose every group
drops is a failure, not an empty diagram.

## 3. Honesty

Architecture classification is a judgment call, and the UI must not let it sound like a fact.

- The style label carries the §5.2.1 badge treatment: `FROM STRUCTURE` (aqua) when `style_basis`
  is `structure` — the folders are literally named `Domain`/`Application`/`Infrastructure`, or the
  projects declare the layering — and `INFERRED` (slate) when it is the model's read. Same pills,
  same tooltips, same colours as provenance; a reviewer who has learned one vocabulary has learned
  both.
- Group summaries are claims. They get no per-claim badge (the map is one artefact, not six), but
  the sheet's footer states the basis once: *"Grouping by <connector name>, from the diff and N
  files it read. Not a build-system fact."*
- The map is **never postable**. It exists to orient the reviewer, and §7.4's gate exists so no
  agent text reaches the PR without human editing; a diagram cannot be edited in a textarea, so it
  cannot be posted. Nothing on the sheet offers it.

## 4. Interaction

- **Open**: a `Map` button in the agent panel header, next to the annotation cycle control. Absent
  (not disabled) when no connector holds `pr.questions` — same rule as the composer.
- **Sheet**: covers the diff column, Esc closes, focus returns to the button. The diff never
  navigates away; the map is a lens, not a page.
- **Click a group** → its files list in the sheet's rail; clicking a file closes the sheet and
  jumps the diff to that file — the citation chip behaviour, via the same `onCite` path.
- **Hover/select a group** → its edges stay full, the rest dim. Selection is also keyboard-reachable:
  groups are buttons in DOM order (outer → core), arrow keys move between them.
- **Flow toggle** → the numbered path lights, everything off-path dims, and the flow reads as a
  sentence under the diagram ("1 Placement request arrives → 2 …"). This is the "reads like a
  flowchart" half of the feature, and it is a *view* of the same graph, not a second artefact.

## 5. The dependency-rule overlay

The one place the map is allowed to editorialise. When `style` is `clean` or `layers`, an edge
pointing outward (`depth(from) < depth(to)`) breaks the dependency rule that defines those styles.
The client — not the model — detects this (it is arithmetic on the emitted graph) and draws the
edge dashed in `--status-warn` with a ⚠ CHECK pill, the §5.2 severity treatment.

This is what makes the map a review tool rather than an illustration: "the domain model calls the
voucher client" is exactly the kind of finding a reviewer wants from a diagram and cannot get from
a file list. Because the detection is client-side arithmetic, the model is never asked to grade its
own architecture reading — it states the edges; the geometry convicts them.

## 6. Rendering

Hand-rolled: layered bands (outer at the top, core at the bottom), group cards inside bands, edges
as SVG paths with arrowheads, all in existing tokens. No mermaid, no reactflow:

- The app is self-hosted with no CDN access, and both libraries fight the token system (their own
  fonts, their own palettes, their own dark mode).
- Layout engines earn their weight at 50 nodes. This graph is capped at 8; three flex rows and
  `getBoundingClientRect` are the whole layout problem.
- Click-to-diff, badge pills and severity treatments are already components; a canvas library
  would mean rebuilding them inside someone else's renderer.

Bands, not rings: concentric circles are the clean-architecture poster, but nodes on arcs waste
half the sheet and curve every label. Horizontal bands stacked outer→core keep the depth metaphor
(a vertical "outer → core" axis labels it explicitly) and read left-to-right like the flow does.

## 7. Persistence, staleness, failure

- Stored per thread and commit like a turn (`MapJson` beside the turns), so reopening is free and
  re-running is a choice (`Remap` button on the sheet), not a surprise bill.
- Head moved since the map was made → §7.3's banner, verbatim: "Mapped against `a3f9c21` — the PR
  has moved since." The map still renders; the banner says why it might lie.
- Schema unparseable or every group invalid → typed failure with Retry (§6). **No prose fallback
  and no partial diagram**: a half-right map misleads with more authority than no map, which is the
  same reasoning that keeps mode-3 prose unbadged.

## 8. Cost

One completion per (PR, commit), cached. The context is the one `PrContextService` already builds
for `/ask` — no second assembly path. Tool reads share `AgentBudget`. Expected added spend for a
reviewer who opens the map once per PR: one answer-sized call, usually cheaper than a question
because the output is capped JSON rather than prose.

## 9. Implementation order

1. `ChangeMapSchema` + caps in `Canonical.cs`, `TaskPrompt.Map(...)`, parser with path validation
   reusing the citation resolver. Testable without UI.
2. `POST /api/review/{project}/{repoId}/pulls/{prId}/map` — same SSE shape (`reading` events, then
   one `map` event), stored via ThreadStore.
3. The sheet: bands, cards, edges, badges, click-to-diff. Mockup `change-map-v1.html` is ground
   truth for geometry and states.
4. Flow toggle and the dependency-rule overlay.
5. The panel-header button, staleness banner, Remap.

## 10. Open questions

- **Annotations on the map?** Gutter markers already exist per cited line; a count pill per group
  ("3 flagged lines in this area") would tie the two features together. Leaning yes, second pass.
- **`unknown` style**: when the agent can't name an architecture, bands degrade to "areas" with no
  depth semantics and the dependency overlay stays off. Is that map still worth showing? Leaning
  yes — grouping alone carries most of the value.
- **Very large PRs**: past the §5.1 truncation cap the map is built from a truncated diff and
  should say so (the context banner already exists). Confirm the wording.
