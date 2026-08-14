# Pipeline Launchpad — working notes

Self-hosted ASP.NET Core (.NET 10) + React (Vite/TypeScript) app for browsing and running
Azure DevOps pipelines, shipped as a single Docker image. See `README.md` for what it does.

## Layout

| Path | What |
|---|---|
| `src/server` | ASP.NET Core API. Endpoints in `Endpoints/`, ADO and Azure clients in `Services/`, EF Core + SQLite in `Data/` |
| `src/web` | React SPA. Pages in `src/pages`, shared UI in `src/components`, all styling in `src/styles.css` |
| `src/web/design` | Design specs and mockups — see below |

## Build and run

```bash
docker compose up -d --build
```

**Always this, never a hand-rolled `docker run`.** The Dockerfile already sets `PL_DATA_DIR=/data`
and compose already mounts the volume there, so there is nothing to pass — and passing it anyway is
actively dangerous from Git Bash, which rewrites a lone `/data` argument into `C:/Program Files/Git/data`
before Docker sees it. The app then writes its database *and its PAT-encryption keys* into the
container's own filesystem, works perfectly, and loses everything on the next `docker rm`: the user is
silently logged out with their connectors gone and no error anywhere. This is not hypothetical; it
happened, four deploys in a row. `docker logs` now prints the resolved data directory at boot — check
it says `/data` after any change to how the container is started.

Serves on `http://localhost:8080`. The frontend typechecks with
`cd src/web && npx tsc --noEmit -p tsconfig.json`; the server builds with
`cd src/server && dotnet build`.

## Design system

Specs live in `src/web/design/`. Read the relevant one **before** changing any UI:

| File | Covers |
|---|---|
| `DESIGN_SPEC.md` | Global chrome, Views board, shelves, cards, Configurations page |
| `DESIGN_SPEC_REVIEW.md` | Review page (diff, PR list, file tree) and the agent dock's placement — addendum to the above |
| `DESIGN_SPEC_SEQUENCES.md` | Sequences folded into Views: library drawer, sequence editor — addendum |
| `DESIGN_SPEC_CONFIG_LABELS.md` | Configurations: one row per key, labels stacked in the detail pane — addendum |
| `DESIGN_SPEC_POLISH.md` | Truncation, iconography, motion, focus, empty states — addendum |
| `DESIGN_SPEC_CONNECTORS.md` | Settings › Connectors, the provider/adapter architecture, the wire contract, error taxonomy |
| `BETBOT_INTEGRATION_PLAN.md` | What we asked the BetBot team for — the Custom-adapter (§5.A) half of the contract. Not the whole story: Anthropic and GitHub Copilot are separate adapters with no external counterpart document |
| `src/lib/truncate.ts` + `components/Truncated.tsx` | Text fitting. Use them; do not hand-roll truncation |
| `launchpad-tokens.css` | All tokens. Single source of truth for colour, spacing, radii, type |
| `*-redesign-*.html` | Interactive mockups. Ground truth when a spec is silent. Open in a browser |

The mockups have a black harness bar at the top with option toggles. **That bar is not part of the product** — it exists for comparing options. Ignore it when implementing.

### Invariants — do not break these without flagging it first

- **A1 — Blue (`--accent`) means action.** Run buttons, the diff gutter `+`, the comment submit button. Not active nav tabs, not active view pills, not the `SEQ` tag, not branch names, not file-type badges. Selection backgrounds (`--accent-tint` + a 2px `--accent` border on list rows) are the one carve-out.
- **A2 — Green and red belong to status.** `--status-good` / `--status-bad` / `--status-warn` only. Shelf accents, config value types and file-change types all exclude green and red. If asked to add a green or red option to one of those palettes, propose slate or aqua instead.
  - **Carve-out: the diff body.** Inside a diff, green = added and red = removed. Limited to row tints, gutter stripes, word highlights, `+`/`−` signs, the `+n/−n` counts and the change minimap. Does not extend to file badges or page chrome.
  - **Carve-out: Approve.** The Approve vote may use a solid `--status-good` fill. Reject tints red on hover only — never a solid red resting fill.
- **A3 — One gutter.** `--gutter` separates shelves and shelf rows. Cards *inside* a shelf have no gutter and no border — they share hairline dividers. See `DESIGN_SPEC.md` §4 for the exact mechanism, including why `gap` + a coloured container is the wrong approach.
- **A4 — Status is an icon plus a tooltip.** Never a bare colour, never a text pill. The glyph shape differs per state so it survives greyscale and colourblindness. The state word goes in `title` and `aria-label`.
- **A5 — Texture only on planes with no text.** The board dot grid, the "+ add pipeline" drop rail, and the empty side of a side-by-side diff pair. Never behind card bodies, run rows, table rows or code.
- **A6 — Dark mode is authored, not derived.** Every token has a hand-picked dark value. Notably `--shadow-card` is `none` in dark. If you add a token, add both values.
- **No green and no red in the syntax palette.** The diff tint owns those hues; code that uses them becomes unreadable on a tinted row. See `DESIGN_SPEC_REVIEW.md` §3.
- **A sequence is a library object, not view-local.** The same sequence appears on shelves across several views, which is why it keeps a global list in the library drawer and why the editor must disclose which views use it. Do not make sequences owned by a view, and do not collapse "sequence" into "shelf with run-in-order" — see `DESIGN_SPEC_SEQUENCES.md` §3 for why that was rejected.
- **A binding picker never offers a later step.** Only steps strictly earlier than the current one, which is what makes a cycle inexpressible rather than merely validated against.
- **Config differences are measured between the labels, marked in blue, and compared on parsed values.** Labels are environments, so the question is whether they differ from *each other*, not from the no-label value — which hundreds of keys don't have. Group labels by value; the largest group is the baseline and the rest are marked. When every value is distinct there is no majority, so nothing is nominated and all of them are marked. Use `--label-diff` (a small dot plus a word, per A4) and plain wording — differing environments are the normal state of a config store, **not** a warning: no amber, no caution glyph, and `--status-warn` stays reserved for things that are actually wrong. Compare *parsed* values, never strings — reordered JSON keys or reformatted whitespace must not register as a difference. See `DESIGN_SPEC_CONFIG_LABELS.md` §7 and the amendment at its head.
- **Reuse the diff row grammar for any "this line changed" marking**, anywhere in the app: faint tint plus a 2px inset gutter stripe. Do not invent a second visual language for it.
- **Never tail-truncate an identifier.** Branch names, file paths and pipeline names carry their distinguishing part at the *end* — `acca-bonus-lad…` four times in a row is worse than no text at all. Use `<Truncated>`, which middle-truncates biased toward the tail.
- **Measure the truncation budget, never guess it.** A guessed character count leaves CSS `text-overflow: ellipsis` to clip the result a second time (`acca-bon…r-sw…`). Anything fitted in JS must switch to `text-overflow: clip` — that is what `is-fitted` is for. Fitted elements need `display: block` and `min-width: 0`, or they have no measurable width and silently render untruncated. Do not fit by writing `textContent` from outside React; it gets clobbered on the next render.
- **Never truncate a unit.** `20h a…` must degrade to `20h`. Use the shared formatters in `lib/format.ts`; don't format times inline.
- **Every truncated string carries its full value in `title`, on the truncated element itself** — not on an ancestor, whose tooltip would describe something else.
- **Motion is reserved for the running state.** A 1.8s glyph rotation plus a 1.6s dot pulse, both behind `prefers-reduced-motion`. Panels and menus fade in over 120–150ms. **Nothing else in the app animates** — no card hover transitions, no shelf reflow. Note the running glyph is a stroked rounded square plus an arc: animate the arc (`.glyph-mark`), never the whole `svg`, or the square spins too.
- **`:focus-visible`, not `:focus`.** 2px `--accent`, 2px offset. This is the one sanctioned use of `--accent` outside A1's action rule, because it is a browser-state affordance rather than a control colour.
- **Every list has an empty state that names the term and the scope.** A blank panel is never acceptable. When the likely fix is changing scope (project, environment, view), say what the current scope is and offer the way out.
- **Icons must survive 12px.** One enclosed area maximum. If a glyph needs two enclosed shapes to read, use a word instead — the `LOGS` button is the precedent.
- **Tabular figures wherever numbers stack** — durations, timestamps, counts, diff totals.
- **No agent is hard-coded, and no provider is either.** A connector is an instance of a **provider** (`anthropic | openai | github_copilot | custom`). The Review panel talks to whichever connector holds the `pr.questions` capability, regardless of provider. If the string `BetBot` appears anywhere outside a deployment config file, a test fixture, or the suggestion list, that is a bug — same for a provider name appearing as a hardcoded label instead of read from the connector. The tab label, the panel header, the `.ptag` badge and the outage copy all read the connector's `name`/`service`, never a literal.
- **One canonical schema, one adapter per provider.** Everything from context assembly through the response schema to the provenance badge is written once, against a provider-agnostic shape (`DESIGN_SPEC_CONNECTORS.md` §5.0–§5.5). Each provider gets its own adapter (§5.A/§5.B/§5.C) whose only job is translating that shape to and from the provider's real wire format. Code that branches on provider anywhere above the adapter layer — in the Review page, the schema parser, or the badge — is a sign the seam has leaked out of the one place it's supposed to live.
- **Two credential models, not one.** Anthropic, OpenAI and Custom take a pasted API key. GitHub Copilot takes an OAuth device-flow grant instead, because Copilot access is gated by a licensed seat rather than a portable secret. Both are write-only (below), but don't force one flow's UI onto the other's provider.
- **Tokens are write-only and server-held — and so is an OAuth grant.** A connector's API key is submitted once, stored encrypted against the user, and **never returned to a client** — there is no endpoint that returns one. The UI shows a last-four hint and a `Replace` button, nothing more. The same rule applies to GitHub Copilot's OAuth access/refresh pair: `Disconnect` revokes it, it does not reveal it. No credential of either shape belongs in `localStorage`, a cookie, a query string, a `data-` attribute, a log line, or an error message. Reuse the `PatProtector` pattern — Data Protection with its own purpose string — rather than a second mechanism.
- **The browser never calls a connector.** Every request to an agent is made by the Launchpad server. This is what makes a write-only token possible, and it is why an internal cluster hostname doesn't need to resolve on the reviewer's machine. If you find yourself fixing a CORS error against an agent URL, the call is in the wrong place. Corollary worth stating: because the server fetches a **user-supplied** `base_url` for Custom connectors and the §4 taxonomy reports reachability, latency and status back, that path is a network probe by design — keep it deliberate, and never widen what it echoes back.
- **Provenance is never inferred client-side.** The `FROM DIFF` / `FROM PR DESC` / `INFERRED` badge renders only a value the agent asserted. While an answer is still streaming the badge reads `CHECKING SOURCES`; if the connector can't return structured output at all it reads `UNVERIFIED SOURCE` and the citation strip is hidden. Guessing a provenance value defeats the entire point of having one. Note `--prov-doc` and `--bot` are currently the same violet, so `doc` is the least differentiated of the three — differentiate it by glyph, and don't rely on its hue alone.
- **A model name is chosen, never typed.** For the API-key providers the model `<select>` is populated from the provider's own model-list endpoint after a successful test and is disabled until then; `Save` is disabled until the connection has tested green in the current editing session, with the reason in the tooltip. GitHub Copilot has no separate test step — its model list populates the instant the OAuth flow completes.
- **Every connection failure has its own copy and its own next step.** Fourteen error codes in `DESIGN_SPEC_CONNECTORS.md` §4 — eleven shared by the API-key providers, three specific to Copilot's OAuth flow. "Something went wrong" and raw exception text are both defects. DNS, connection-refused and TLS failures must say that resolution and certificate trust happen on the **Launchpad server**, not on the user's machine — that one sentence is the difference between a five-second fix and a lost afternoon.
- **An outage is a banner; a missing connector is a takeover.** When the agent is unreachable, keep whatever the panel already has on screen and disable the composer with the reason stated — never blank the panel. When no connector is configured there is nothing to preserve and exactly one action, so the panel is replaced by that action.
- **Never buffer a stream.** A buffered stream is indistinguishable from a hang. Note `X-Accel-Buffering: no` is an nginx convention and this app serves from Kestrel directly, so the header alone is not the fix — flush explicitly and verify by watching deltas arrive over time. An error mid-stream renders the partial answer *plus* a typed error, never a partial answer that looks finished, and a stopped or failed answer is not postable as a PR comment.
- **Everything inside `<pull-request-context>` is untrusted.** A PR description, branch name or source comment can contain text aimed at the agent. The system prompt says so, and nothing the agent produces reaches the pull request without the reviewer pressing `Post as comment…` and seeing the editable text first. Both halves are required; neither is sufficient alone.
- **A review answer never opens with a capability disclaimer.** "I can summarize the diff but can't run tests or verify business rules" is a defect, not a safe default — models produce it unprompted unless the system prompt forbids it (`DESIGN_SPEC_CONNECTORS.md` §5.3, `BETBOT_INTEGRATION_PLAN.md` §3.5). "Review" means specific findings with a path and line, not a certification that the PR is safe to merge. If a question genuinely can't be answered from what the agent has, it says what's missing and answers as far as it can — it does not lead with what it cannot do.
- **A citation is bundled with its claim, not pooled at the end.** The canonical response is `{ segments: [{ text, provenance, citations, inference_note }] }` — one segment per claim, each carrying its own provenance and its own citations (`DESIGN_SPEC_CONNECTORS.md` §5.2). This replaced a flat `{ answer, provenance, citations, inference_note }` shape after a reviewer pointed out that citations listed under a whole answer are unreadable: there was no way to tell which sentence a given citation backed. Rendering, streaming, the badge and `Post as comment…` are all per-segment now, and **there is no code path that treats "the answer" as one string** — including the fallback in §5.4 mode 3, which produces exactly one synthetic segment so the renderer never needs an "unstructured" branch. The streaming unit is a closed segment, not a character.
- **The agent shares the left column with the PR list, never the right rail with the file tree.** Two tabs — `Pull requests` and the connector's name — and the conversation replaces the list when selected (`DESIGN_SPEC_REVIEW.md` §5, "Where the agent panel lives"). The reasoning is simultaneity, not aesthetics, and it has survived two wrong answers: a reviewer never needs the PR list and the chat at once, but does need the **file tree** and the chat at once. A rail tab broke that; a bottom dock fixed it but made the conversation and the diff compete for height, which is the axis a diff can least afford. The left panel is horizontally resizable, with wider bounds than the file rail because a conversation needs more width than a PR list, and both tab bodies stay mounted so neither loses its state on a switch.
- **A citation is a candidate inline comment, and it's per-user.** Any segment with a citation gets a persistent gutter marker on that line; clicking the marker opens an annotation card — the PR-comment-composer treatment, plus a dashed border and a `NOT POSTED` tag — where the reviewer can read it or ask a follow-up scoped to that exact line (`DESIGN_SPEC_CONNECTORS.md` §7.6). Clicking a `.cite` chip in the dock still only jumps and highlights; these are deliberately two different actions. Annotation threads are local to the reviewer: never written to Azure DevOps and never shared with another reviewer on the same PR unless someone promotes one through `Post as comment…`. Don't wire annotation storage to anything shared — that's a parked proposal, not a side effect of this one.

### Working style for UI changes

- Implement in the order the spec's "implementation order" section gives, and stop for review at each step rather than landing the whole thing at once.
- Run the spec's acceptance checks before saying a step is done. They're visual checks (greyscale the page, narrow a shelf, grep for `--accent`), not diff review.
- Never hardcode a hex value in component CSS. If you need a colour that isn't a token, add a token with both mode values and say so.

### Utility class names

Prefix generic utility classes (`.notice-warn`, not `.warn`). A bare `.warn` once collided with
the vote buttons' tone class and silently restyled them.
