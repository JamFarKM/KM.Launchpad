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

- **Open**: the `Review` button (§4.1) and thereafter a `Map` control in the agent panel header, next
  to the annotation cycle control. Absent (not disabled) when no connector holds `pr.questions` —
  same rule as the composer.
- **Sheet**: covers the diff column, Esc closes, focus returns to the button. The diff never
  navigates away; the map is a lens, not a page.
- **Click a group** → its files list in the sheet's rail; clicking a file closes the sheet and
  jumps the diff to that file — the citation chip behaviour, via the same `onCite` path.
- **Hover/select a group** → its edges stay full, the rest dim. Selection is also keyboard-reachable:
  groups are buttons in DOM order (outer → core), arrow keys move between them.
- **Flow toggle** → the numbered path lights, everything off-path dims, and the flow reads as a
  sentence under the diagram ("1 Placement request arrives → 2 …"). This is the "reads like a
  flowchart" half of the feature, and it is a *view* of the same graph, not a second artefact.
- **Edge labels appear on hover, one at a time.** Selecting a group lights *which* edges belong to
  it; pointing at one asks *what it does*. Those are separate questions, and answering both at once
  put five pieces of text on a seven-node graph. Edges carry a 14px transparent hit path, because a
  1.4px line is not a pointer target.
- **Nothing is labelled at rest, including the violation.** The warning is carried by the dashed
  amber line and the card's ⚠ pill — both always visible, both wordless. Only the sentence explaining
  it waits to be asked for: a permanent block of amber text read as clutter rather than urgency, and
  the sign that a signal is too loud is that it stops being read. The footer states what a dashed
  edge means, so the vocabulary is learnable without hovering anything.

### 4.1 One `Review` button

The map should not be a second thing to go and ask for. §7.3 already gives the panel a landing state
built from the automated review Launchpad parses out of the PR's own threads, and the map is the same
material with a shape — so they arrive together, from one action.

`Review` sits in the agent panel header, and one press does both: run the review, build the map. The
stream is already SSE with typed events (§6), so one request carries both payloads — `reading` events
while the agent works, then the review findings and one `map` event. No second endpoint to authorise,
no second spend to explain, and no state where a reviewer has a map but not the findings it indexes.

**The map is the review's table of contents.** Each group shows the count of review findings citing
lines inside it, and clicking through goes to the finding rather than merely to the file. That is the
thing neither half does alone: the review tells you *what* is wrong, the map tells you *where in the
system*, and a count per area tells you which area to read first. It also gives the map a job for
reviewers who would never open a diagram for its own sake.

Three states the button has to carry, all of which already exist elsewhere in §7:

| State | Button | Panel |
|---|---|---|
| Never run for this commit | `Review` | Suggested-question chips (§7.3's fallback) |
| Running | `Reviewing…` + Stop | `reading` trace, segments streaming, map builds last |
| Done | `Re-review` | Findings, with `Map` beside it |

Cached per `(PR, commit)` like a turn, so reopening is free and re-running is deliberate. When the
head moves, §7.3's stale-commit banner already covers both halves — the findings and the map went
stale together, because they were produced together.

**Why not two buttons.** A `Map` button alone asks the reviewer to want a diagram before they know
what it shows, which is the wrong order: the interesting thing about the map is where the findings
land, and that is only true once findings exist. Keeping `Map` as a control that appears *after* a
review — rather than an action that triggers one — is what makes it a lens on work already done.

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

### 6.1 Edges are orthogonal, never curved

The first version drew beziers and was genuinely hard to read: a curve leaves a card at a slant, and
a slant makes the reader hunt for which card an edge actually came from. Right angles with small
rounded corners are the idiom a layered diagram reads in, and they make an edge's origin unambiguous.

Three shapes, by how many bands an edge spans:

| Span | Shape |
|---|---|
| Same band | Straight horizontal between facing sides |
| Neighbouring bands | Down out of the source, across in the gutter, down into the target — and **nothing but a straight vertical** when the two cards are column-aligned |
| Two or more bands | Out the side, along a channel in the right margin, back in |

The third is deliberately *not* the direct line: the direct line crosses a band that is not party to
the edge, which is what made the violation arrow unreadable in v1.

**No edge may cross a card it does not belong to.** Every candidate path is tested against every
other card's rectangle, and a blocked path falls back to the channel — so this is a property of the
renderer, not something that has to hold by luck of the data.

**And no edge may run along another edge.** Cards are not the only obstacles. Each routed edge
records its segments, and the next edge scores its options against them, distinguishing two things
that look similar and are not:

- *Collinear overlap* — two edges sharing a line — reads as one edge and is what actually makes a
  diagram unfollowable. Heavily avoided.
- *A right-angle crossing* is ordinary diagram grammar and perfectly legible. Mildly avoided, never
  at the cost of a worse route.

Gutters are deep enough for several parallel tracks, and a horizontal run picks the track that
collides least. Without this the violation edge ran its corridor straight down the gap the
orchestration→validation arrow already occupied: legal by the card check, unreadable on screen.

### 6.2 Cards are one width, and bands never wrap

All cards share a width, computed so the busiest band fits on one row. Two things follow, and both
matter more than they look:

- **Columns line up across bands**, which is what lets a dependency between two aligned groups be a
  single straight vertical line rather than a dog-leg.
- **The gutter between bands is genuinely empty**, which is what makes it safe to route through. When
  a band wrapped to two rows in v1, the flow arrow from the endpoint to the orchestrator ran straight
  through the card that had wrapped beneath it.

Below a floor width the band is allowed to wrap instead of shrinking cards past readability, and
§6.1's obstacle check absorbs the consequence.

Each band label carries a deep bottom margin. That space is a routing lane — an edge arriving from
the channel comes in through it — and at label-margin defaults it ran through the label text.

### 6.3 Group order is searched, not swept

Because §2 caps a map at 8 groups, the space of arrangements is small enough to search outright, and
an exact answer beats a heuristic that can stall in a local minimum. Every arrangement is scored;
the best wins. Above the budget it degrades to a hill-climb rather than hanging.

The score is what "reads better" means, in priority order:

| Term | Weight | Why |
|---|---|---|
| Crossings | ×100 | Two edges between the same band pair that swap over — the one thing a reader genuinely cannot follow |
| Skip-edge span | ×5 | A skip travels a corridor and two gutters; every column it crosses is a column its route must thread past |
| Ordinary span | ×3 | Shorter is straighter is easier |
| Column alignment | −6 (reward) | Neighbouring-band groups in one column get a single straight vertical, the most legible edge there is |

**Skip edges must be in the objective.** Leaving them out — on the reasoning that they route around
the bands between them anyway — meant the groups whose *only* connections are skips had nothing
pulling them anywhere, and they sat wherever the model happened to emit them, at the far right, with
their edges crossing the whole sheet to reach the group they describe. Weighting them above ordinary
edges is what pulls them home.

DOM order follows the final arrangement, so keyboard traversal and the visual left-to-right order
stay the same thing.

### 6.4 A note on doing this with a library

This renderer is a small Sugiyama implementation, and there are two mature ones — [dagre] and
[elkjs] — that do the same work better: crossing minimisation, orthogonal routing with real port
constraints, obstacle avoidance.

They were dismissed early on for the wrong reason ("no CDN access"). That objection applies to
*rendering* libraries like mermaid or reactflow, which arrive with their own fonts, palettes and dark
mode to fight. dagre and elkjs are **layout-only**: they compute coordinates and draw nothing, they
are bundled by Vite at build time like any other dependency, and no CDN is involved.

The hand-rolled version stays for now — at 8 nodes it is sufficient, and it keeps rendering entirely
inside our own token vocabulary. But if the cap ever lifts, or nested groups arrive, **elkjs is the
right answer, and the objection recorded here should not be what stops it.**

[dagre]: https://github.com/dagrejs/dagre/wiki
[elkjs]: https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html

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
2. `POST /api/review/{project}/{repoId}/pulls/{prId}/review` — the §4.1 button's one request: same
   SSE shape, `reading` events, then findings, then one `map` event. Stored via ThreadStore.
3. The sheet: bands, cards, edges, badges, hover labels, click-to-diff. Mockup `change-map-v1.html`
   is ground truth for geometry, routing and states.
4. Flow toggle and the dependency-rule overlay.
5. The `Review` button's three states, per-group finding counts, staleness banner, `Re-review`.

## 10. Open questions

- **Annotations on the map?** §4.1 puts review-finding counts on each group. Inline annotations
  (§7.6) are a second countable thing per area, and showing both risks two numbers meaning different
  kinds of attention. Leaning: findings only, and let a group's annotations surface when you click
  into it.
- **Does `Review` post to the pull request?** §7.3's review is read *from* PR threads, which assumes
  something else posted it. If Launchpad's own `Review` is to be that something, it crosses §7.4's
  human-edit gate for the first time at run scale. Likeliest answer: `Review` stays local to the
  panel and posting remains per-claim through the existing sheet — but this needs deciding before
  step 2, not after.
- **`unknown` style**: when the agent can't name an architecture, bands degrade to "areas" with no
  depth semantics and the dependency overlay stays off. Is that map still worth showing? Leaning
  yes — grouping alone carries most of the value.
- **Very large PRs**: past the §5.1 truncation cap the map is built from a truncated diff and
  should say so (the context banner already exists). Confirm the wording.
