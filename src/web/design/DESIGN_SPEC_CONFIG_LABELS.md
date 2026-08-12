# Configurations: one row per key, labels stacked in the detail pane
### Design spec — addendum to DESIGN_SPEC.md

**Status:** implemented, with one amendment to the comparison model (below)

> ### Amendment — drift is measured *between the labels*, not against the baseline
>
> As written, this doc compares each named label to the no-label baseline. Built against the real
> Dev store, that turned out to answer the wrong question. Labels here are environments
> (`AKS-GLI`, `AKS-INT`, `AKS-TEST1`, `Development`, …), and what the page is opened to ask is
> **"do these environments differ from each other?"** — which a baseline-relative comparison
> cannot answer at all for the **475 keys that have no no-label value**.
>
> So: labels are grouped by the value they hold, the largest group is the **shared** value, and
> the labels outside it are the drift. Ties go to the baseline. Line marking highlights the lines
> that are not common to *every* label, and applies to every section rather than only to
> outliers, since the varying part is worth seeing from both sides.
>
> **The baseline is the most common value.** Whichever value the most labels hold is what the
> others are measured against, no-label or not. When *every* label holds a different value there
> is no majority and nothing is nominated — each label is simply marked, and the list says
> `all differ`. §4's rule that the no-label value is never *silently* treated as authoritative
> survives in a stronger form: it now has to earn the position by being the most common, and it
> only breaks ties. It keeps a separate muted `DEFAULT` marker for identity, since "what resolves
> when no label is asked for" is still worth knowing.
>
> **Not a warning.** §3's `--drift` (an alias of `--status-warn`) is replaced by `--label-diff`,
> the blue identity hue. Environments holding different values is the normal condition of a
> config store, not a fault, so the marker is a small dot and the wording is plain — `2 differ`,
> `all differ`, `4 of 6 differ from the rest`. No caution triangle, no amber, no tinted alert
> strip. `--status-warn` is left for things that are actually wrong. A4 still holds: the dot is
> always accompanied by the word.
>
> The §6 tag vocabulary is `BASELINE` / `DIFFERS` / `SAME`. The list's value column shows the
> baseline and is headed `Value (shared)`.
**Scope:** the Configurations page's key list and detail pane. No change to the namespace pane, the environment pills, or the endpoint strip.
**Reference files:**

| File | What it is |
|---|---|
| `src/web/design/configurations-labels-v1.html` | Interactive mockup. Ground truth for anything this doc doesn't pin down. |
| `src/web/design/DESIGN_SPEC.md` | Parent spec. Invariants A1–A6 apply unchanged. |
| `src/web/design/launchpad-tokens.css` | Existing tokens. This change adds three (§3). |

The mockup's black harness bar — the `Current / Proposed` toggle — **is not part of the product**. It exists so the two list shapes can be compared on the same data. `Current` reproduces today's behaviour; `Proposed` is the design.

---

## 1. What this supersedes

In `DESIGN_SPEC.md` §2.4, two rows of the three-pane table are replaced:

| Pane | Was | Becomes |
|---|---|---|
| Keys | table of Key / **Label** / Value preview / Type, one row per key **per label** | one row per **key**: Key / **Labels** (count + drift marker) / Value (baseline) / Type |
| Detail | `470px`, one value | `520px`, one collapsible section **per label** |

Everything else in §2.4 stands: one scroll context per pane, no modal, no nested scrollbars, environment identity on the endpoint strip, value-type badges, key-count magnitude ramp.

---

## 2. The problem

A key that carries three labels is three rows today, so a namespace list is padded with repeats of the same key name and the question people actually open this page to answer — *does this key differ between `no label` and `staging`?* — requires finding the rows, reading them, and comparing them by eye. In a 290-key namespace like `Placement` that is not a realistic thing to do.

Collapsing to one row per key both shortens the list and creates somewhere to put the answer.

---

## 3. Tokens

```css
[data-theme="light"] {
  --label-default:#5c6672;   /* the baseline (no-label) value */
  --label-named:  #6b5bd6;   /* a named label                 */
  --drift:        var(--status-warn);
}
[data-theme="dark"] {
  --label-default:#8b95a3;
  --label-named:  #9085e9;
  --drift:        var(--status-warn);
}
```

`--label-default` and `--label-named` are the existing slate and violet identity hues. `--drift` is an **alias of `--status-warn`**, not a new colour.

**Amber, not red.** A label differing from the baseline is normal and expected — that is what labels are *for*. It is a "look here" state, not a failure, so it never uses `--status-bad`. This also keeps green and red with pipeline status (invariant A2).

Geometry: detail pane `520px`. Key list columns `200px 104px minmax(0,1fr) 62px` with a `12px` gap.

---

## 4. The baseline

**Definition:** the baseline is the value stored with **no label**. It is what the app resolves when a request doesn't ask for a label, which is why it is the right thing to preview in the list and to compare named labels against.

**Edge case that needs a decision before building:** a key can exist *only* under named labels, with no no-label value. The mockup falls back to the first label alphabetically and still calls it the baseline, which is wrong — it implies a resolution order that doesn't exist. Options, in my order of preference:

1. Show `no baseline` in the list's value cell, and in the detail pane render all labels as peers with no `SAME`/`DIFFERS` tags (there is nothing to differ *from*).
2. Nominate the alphabetically-first label as a comparison anchor, but label the section `ANCHOR` rather than `BASELINE` so it doesn't read as a resolution rule.

Pick one and make it explicit; do not ship the mockup's silent fallback.

---

## 5. The key list

One row per key.

| Column | Width | Contents |
|---|---|---|
| Key | 200px | monospace, 600 weight, truncate at end |
| Labels | 104px | `N label` / `N labels`, plus a `DIFFERS` marker when applicable |
| Value | fill | preview of the **baseline** value, monospace, muted, truncate at end |
| Type | 62px | type badge derived from the **baseline** value |

The header count line becomes `{keys} keys · {values} label values · {Env}` so the compression is legible and the underlying volume isn't hidden.

### The DIFFERS marker

Shown when any named label's value differs from the baseline. It carries an icon **and** the word `DIFFERS` — never colour alone (invariant A4) — with a `title` naming which labels differ.

This marker is the reason the change is a net gain rather than a trade. Collapsing the rows removes your ability to spot drift by reading; the marker replaces it with something better, because drift becomes scannable down a column instead of assembled by eye.

---

## 6. The detail pane

Header is the key path plus close. Then a summary strip, then one collapsible section per label.

### Summary strip

- **Drift present:** `--drift`-tinted background with a 2px left rule, an icon, `N of M named labels differ from the baseline`, and a **jump chip per differing label** that expands and scrolls to that section.
- **No drift:** neutral background, `All N values identical.`

### Label sections

Order: **baseline first**, then named labels alphabetically.

Each section header carries: a chevron, a label chip (`no label` in `--label-default`, named labels in `--label-named`), a status tag, and a copy button.

| Section | Tag |
|---|---|
| baseline | `BASELINE` (muted, uppercase, not a pill) |
| named, matches baseline | `SAME` (neutral pill) |
| named, differs | `DIFFERS` (amber pill with icon) |

**Default collapsed state:** the baseline is open; named labels that **match** start **collapsed**; named labels that **differ** start **open**. The pane opens on exactly what needs looking at. Compare `AccaBonus → 10000000` (quiet) with `20050000` (both labels open) in the mockup.

### Marking the differences

Inside a differing label's value, mark the lines that differ from the baseline with a faint `--drift` tint and a 2px inset gutter stripe.

**Use the same grammar as the Review page's diff rows** — faint background, stripe carries the identification (`DESIGN_SPEC_REVIEW.md` §3). Getting this right is what makes the two pages read as one system rather than two separate efforts.

Implementation note: render every line as a `display:block` span and join with **no** newline. A `\n` between block spans produces an extra blank row per line.

---

## 7. Comparison semantics — get these right

Two places where the naive implementation produces wrong answers:

**1. Compare parsed values, not strings.** `{"a":1,"b":2}` and `{ "b": 2, "a": 1 }` are the same configuration. A string comparison flags them as drift and the `DIFFERS` marker becomes noise nobody trusts. Parse both and deep-compare; for non-JSON values compare after trimming.

**2. Canonically format before line-diffing.** Line-level marking must run on both values pretty-printed by the *same* formatter, or whitespace and key order differences light up rows that are semantically identical. Format both, then diff.

**Data fetching:** computing drift needs every label's value for every key in the namespace. The current page already fetches all key-values to build its row-per-label list, so this should need no extra requests — confirm that before adding any per-key fetch. Do **not** introduce a request per row; `Placement` has 290 keys.

---

## 8. Implementation order

1. **Grouping.** Reshape the fetched key-values into `key → { label → value }`. Pure data, no UI. Verify counts against today's row count.
2. **Comparison helpers** (§7) — deep equality and canonical formatting, with the baseline rule from §4. Unit-test these; everything downstream is wrong if they are.
3. **Key list** (§5) — one row per key, label count, baseline preview and type, header count line.
4. **DIFFERS marker** (§5) — needs step 2.
5. **Detail pane sections** (§6) — stacked sections, chips, tags, default collapsed state. No line marking yet.
6. **Summary strip + jump chips** (§6).
7. **Line-level difference marking** (§6) — last, and reuse the diff row styling rather than writing new CSS.

---

## 9. Acceptance checks

- [ ] `AccaBonus` shows 3 rows, not 6; the header reads `3 keys · 6 label values · Dev`.
- [ ] `20050000` shows `3 labels` with a `DIFFERS` marker; `10000000` shows `2 labels` with none.
- [ ] The value preview and type badge both come from the baseline, not from an arbitrary label.
- [ ] Reordering the keys inside a JSON value, or reformatting its whitespace, does **not** trigger `DIFFERS`.
- [ ] Selecting a key opens sections baseline-first, matching labels collapsed, differing labels expanded.
- [ ] Jump chips in the summary strip expand and scroll to the right section.
- [ ] Differing lines are tinted with a gutter stripe; identical lines are not; no blank row appears between lines.
- [ ] A key with only named labels and no no-label value behaves per the §4 decision — and does not silently present one label as the baseline.
- [ ] Greyscale the page: `SAME` vs `DIFFERS` and the list marker are still readable.
- [ ] Dark mode: label chips, drift tint, the summary strip and the line marking all remain legible.
- [ ] No per-row network request; a 290-key namespace opens in one fetch.

---

## 10. Open question

**Scalars are over-served by stacked sections.** `Flexicut → MaxSelections` is `12` at baseline and `20` in `staging` — two collapsible panels and two code blocks to show two short numbers. Worth considering a compact inline form when *every* value for a key is a one-liner:

```
no label   BASELINE   12
staging    DIFFERS    20
```

…with stacked sections reserved for JSON and other multi-line values. This would need a rule for what counts as compact (single line under ~60 chars, perhaps). Judge it against `MaxSelections` in the mockup before deciding — I left it out rather than guessing, since it adds a second rendering path.
