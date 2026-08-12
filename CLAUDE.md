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

Serves on `http://localhost:8080`. The frontend typechecks with
`cd src/web && npx tsc --noEmit -p tsconfig.json`; the server builds with
`cd src/server && dotnet build`.

## Design system

Specs live in `src/web/design/`. Read the relevant one **before** changing any UI:

| File | Covers |
|---|---|
| `DESIGN_SPEC.md` | Global chrome, Views board, shelves, cards, Configurations page |
| `DESIGN_SPEC_REVIEW.md` | Review page (diff, PR list, file tree) — addendum to the above |
| `DESIGN_SPEC_SEQUENCES.md` | Sequences folded into Views: library drawer, sequence editor — addendum |
| `DESIGN_SPEC_CONFIG_LABELS.md` | Configurations: one row per key, labels stacked in the detail pane — addendum |
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

### Working style for UI changes

- Implement in the order the spec's "implementation order" section gives, and stop for review at each step rather than landing the whole thing at once.
- Run the spec's acceptance checks before saying a step is done. They're visual checks (greyscale the page, narrow a shelf, grep for `--accent`), not diff review.
- Never hardcode a hex value in component CSS. If you need a colour that isn't a token, add a token with both mode values and say so.

### Utility class names

Prefix generic utility classes (`.notice-warn`, not `.warn`). A bare `.warn` once collided with
the vote buttons' tone class and silently restyled them.
