# Connectors — design spec (addendum to DESIGN_SPEC.md)

**Status:** approved mockups, ready to implement
**Scope:** a new `Connectors` section in Settings, plus the changes to the Review page's agent panel that
follow from an agent being configurable rather than hard-coded. Covers **four providers** — Anthropic, OpenAI,
GitHub Copilot, and Custom (any OpenAI-compatible endpoint) — behind one canonical internal schema, so the
Review panel is identical no matter which one answers. Includes the Launchpad-side wire contract for the Custom
adapter; the matching ask on that agent's side is in `BETBOT_INTEGRATION_PLAN.md`. The Anthropic and GitHub
Copilot adapters are Launchpad-side only — there is no external team to hand a plan to.
**Reference files (commit alongside this doc):**

| File | What it is |
|---|---|
| `src/web/design/connectors-settings-v1.html` | Interactive mockup, Settings › Connectors. Ten states, including the four-provider picker, an Anthropic key flow, and a GitHub Copilot OAuth flow (pending and connected). Ground truth for anything this doc doesn't pin down. |
| `src/web/design/betbot-review-v1.html` | Interactive mockup, the agent panel on the Review page. Seven panel states, plus a top-right **Connector** switch (BetBot / Claude via Anthropic / Copilot) that re-points the same panel live — the fastest way to see what "no seams" means. |
| `src/web/design/DESIGN_SPEC.md` | Parent spec. Invariants A1–A6 apply unchanged. |
| `src/web/design/DESIGN_SPEC_REVIEW.md` | Review page spec — diff rendering, composer, file tree. It predates the agent panel and does not mention it; the provenance badge rules live in §5.2.1 below, not there. |
| `src/web/design/BETBOT_INTEGRATION_PLAN.md` | The contract we are asking the BetBot team to implement — the Custom-adapter half of §5.A. §5.A here and §3 there must stay identical. |
| `src/web/design/sample-request.json` | A real §5.A request body, non-streaming. The schema in it is the canonical schema in §5.2 — keep them equal. |
| `src/web/design/sample-request-stream.json` | The same, streaming, on a second turn, so it exercises history replay. |
| `src/web/design/injection-fixture.json` | A request whose PR description carries an instruction aimed at the agent. Expected behaviour: the answer ignores it and says the description contains one. |

The black harness bar at the top of both mockups — the state switcher and the theme toggle — **is not part of
the product.**

`sample-request.json`, `sample-request-stream.json` and `injection-fixture.json` are listed above but were not
supplied with this doc. They are generated from the canonical shapes once §5.2 exists in code, rather than
hand-authored, so they cannot drift from the schema they are meant to demonstrate.

---

## 0.0 Amendments found while implementing

Four places where this spec and the app it targets disagree. Recorded here rather than silently worked around,
because each would otherwise be rediscovered.

1. **§2's data model is written in Postgres types; Launchpad is SQLite.** `uuid`, `bytea`, `timestamptz` and
   `text[]` have no direct equivalents. `capabilities text[]` in particular becomes its own table — which is
   better anyway, because the exclusivity rule in §2 ("assigning a capability removes it from whichever connector
   held it, in one transaction") is expressible as a constraint on a join table and is not expressible on an array
   column. `bytea` → `BLOB`, `timestamptz` → ISO-8601 `TEXT`. There is no migrations framework: tables are raw
   `CREATE TABLE IF NOT EXISTS` in `Program.cs`, so §2's check constraint is hand-written.
2. **§6's `X-Accel-Buffering: no` is inert in this deployment.** The spec already notes the header is an nginx
   convention; this app has no proxy at all — Kestrel serves `wwwroot` directly. The header costs nothing and is
   kept for the day one is introduced, but what actually prevents buffering here is explicit flushing on the SSE
   response. Setting the header and considering §6 done would ship the exact bug the section exists to prevent.
3. **§3 says "the Settings sheet gains a left-hand section nav". There is no Settings sheet.** Settings today is a
   cog dropdown holding the theme toggle and notification prefs. The connector list, inline editor, capability
   radios and test-result banner cannot live in a dropdown, so this feature builds the sheet. `Appearance` takes
   over the dropdown's existing contents; `Projects` and `About` appear in the mockup, are specified nowhere, and
   are left out until they are.
4. **`--prov-doc` and `--bot` are the same violet** (`#6b5bd6` light, `#9085e9` dark). §5.2.1 requires the badge
   hue never to become an identity colour, but violet already *is* the assistant identity — the answer's left
   border, the name, the cursor, the citation hover and the cited diff row all use it. So on a `doc`-grounded
   answer the badge is the same hue as the chrome around it, and `doc` ends up the least differentiated of the
   three: it shares its hue with identity *and* its glyph (the check) with `code`. The label still carries the
   meaning, so this is a muddle rather than a defect. Fix by giving `doc` its own glyph rather than by introducing
   a fifth hue — the only unused one is orange, which collides with `--status-warn` on the stale banner two
   elements away.

---

## 0. The decision this document encodes

No agent — BetBot or otherwise — is hard-coded. A connector is an instance of a **provider**
(`anthropic | openai | github_copilot | custom`), and the Review page does not ask any specific one of them
anything; it asks *whichever connector currently holds the `pr.questions` capability*. Adding Anthropic directly,
running Copilot alongside BetBot, or pointing a developer's Launchpad at a local model are all settings changes.

Four choices set the shape of everything below, and each has a consequence worth stating plainly:

1. **Connectors are per-user.** Each reviewer registers their own credential. Questions and cost attribute to a
   person rather than to a shared service identity. The cost is that nothing is standardised for the Custom
   provider — mitigated, but not eliminated, by the shipped suggestion in §3.4. Anthropic, OpenAI and Copilot
   don't have this problem: there's no URL to get wrong, only a credential to supply.
2. **One canonical schema, one adapter per provider.** Launchpad defines its own internal request/response shape
   (§5.0) and translates it to and from each provider's native wire format. The Custom and OpenAI adapters are
   near pass-throughs, because the canonical shape was deliberately chosen to equal OpenAI's; Anthropic and
   GitHub Copilot need real translation. This is where the seam actually lives — moved to one place, on the
   server, instead of scattered across every screen a reviewer touches.
3. **Two credential models, not one.** Anthropic, OpenAI and Custom take a pasted secret. GitHub Copilot takes an
   OAuth grant instead, because Copilot access is tied to a licensed seat on a GitHub identity, not a portable
   key. Both are write-only from the browser's perspective (§3.3), but they are genuinely different flows and the
   UI says so rather than forcing one shape onto both.
4. **Launchpad owns the conversation.** Threads are stored by Launchpad against `(user, pull request)`, and the
   full history is replayed on every request in the canonical shape, before any adapter sees it. Connectors stay
   stateless, which is what makes them interchangeable — a thread survives swapping the provider underneath it,
   mid-conversation if need be.

---

## 1. Invariant compliance

No amendments to A1–A6 are needed. For the avoidance of doubt, in this feature:

- **A1 — blue is action only.** `Test connection`, `Save`, `Connect`, `Add connector`, `Connect an agent`, and
  the `Settings › Connectors` deep link. The connection status indicator is **not** blue.
- **A2 — green and red are status only.** The connection dot and the test-result banner are genuine health
  signals and use `--status-good` / `--status-bad` legitimately. Nothing else in this section may use either
  hue — in particular, `Remove` is a red *outline and hover tint*, never a solid red fill.
- **A4 — status is an icon plus a tooltip, and the shape differs per state.** A filled dot for connected, a
  filled dot in `--status-bad` for unreachable, a hollow square for never-tested, and a pulsing dot for a GitHub
  OAuth grant in progress (§3.3.1) — four states, four treatments, and the state is always spelled out in a word
  beside the indicator so hue is never load-bearing alone.
- **A3 — one gutter.** Connector rows sit in a single bordered container separated by hairlines, with no gaps
  between rows and no per-row border. The inline editor is part of that container, not a floating card.
- **A5 — texture only on planes with no text.** The dotted backdrop behind the settings scrim in the mockup is
  standing in for the Views page underneath. Do not add texture inside the sheet.
- **A6 — dark mode is authored.** No new hues are introduced by this feature; it reuses `--accent`,
  `--status-*`, and `--hue-violet`, all of which already have authored dark values.

One new use of an existing token: `--hue-violet` (aliased `--bot`) marks the connector holding the
`pr.questions` capability, matching the agent panel on the Review page. This is deliberately **not** a
per-provider colour — it means "the one answering right now," and stays the same violet whether that's BetBot,
Claude, or Copilot underneath. Providers are told apart by icon and name in the connector list (§3.1), never by
hue; a colour per vendor would fight both A1/A2 and its own purpose, since the badge means something different
(active vs. identity) than a fourth or fifth hue would.

---

## 2. Data model

Server-side. One row per connector per user. `provider` is the new column that drives everything else — which
fields apply, which adapter handles requests, and which credential shape the editor shows.

```
connector
  id                uuid
  user_id           fk            -- connectors are never shared
  provider          enum          -- 'anthropic' | 'openai' | 'github_copilot' | 'custom'
  name              text          -- display only, free text, mutable
  base_url          text          -- fixed by provider for anthropic/openai; editable for custom;
                                   -- null for github_copilot, which has no URL concept from the user's side
  model             text          -- must be a value the provider's adapter reports as available
  auth_type         enum          -- 'api_key' | 'oauth' — derived from provider, stored for query convenience
  token_ciphertext  bytea         -- api_key connectors only. Encrypted at rest, never egresses to a client
  token_last4       char(4)       -- the only part the UI ever sees
  token_set_at      timestamptz
  oauth_login       text          -- oauth connectors only: the linked GitHub username
  oauth_access_ciphertext  bytea  -- oauth connectors only. Short-lived; refreshed server-side
  oauth_refresh_ciphertext bytea  -- oauth connectors only. Long-lived; never egresses to a client
  oauth_scope       text
  oauth_expires_at  timestamptz
  capabilities      text[]        -- currently only 'pr.questions'
  last_ok_at        timestamptz   -- last successful call of any kind
  last_error_code   text          -- see the taxonomy in §4
  last_error_at     timestamptz
  created_at        timestamptz
```

**Rules.**

- `capabilities` is exclusive per `(user_id, capability)`, **across providers**. Assigning a capability to a
  connector removes it from whichever connector held it, in one transaction, regardless of what provider either
  one is. There is no "no connector assigned but connectors exist" state that the UI hides — if the user removes
  the assignment, the Review panel shows `Not connected`.
- `name` is free text and does not have to match the provider or the model. This matches the existing treatment
  of card titles on the Views page: user-facing labels are the user's, and mutating one never mutates anything
  upstream.
- Exactly one of the api-key columns or the oauth columns is populated, matching `auth_type`. A row with both, or
  neither, is invalid — enforce with a check constraint, not just application code.
- `base_url` is `NULL` and not shown for `github_copilot`. For `anthropic` and `openai` it's populated from a
  fixed constant at creation time (so the adapter never has to special-case "provider says X but URL says Y") and
  rendered as read-only text, never an editable field (§3.2).
- Deleting a connector deletes its stored credential — key or OAuth token pair — and cascades to its capability
  assignments. It does **not** delete conversation history — see §7.5.

### 2.1 API

```
GET    /api/connectors                       -> [connector without any credential material, with token_last4 or oauth_login]
POST   /api/connectors                       { provider, name, base_url?, model?, token?, capabilities }
PATCH  /api/connectors/:id                   { name?, model?, token?, capabilities? }
DELETE /api/connectors/:id
POST   /api/connectors/:id/test              -> { ok, latency_ms, models?, error_code?, http_status? }
POST   /api/connectors/test                  { provider, base_url?, token? }   -- test before first save (api-key providers)

POST   /api/connectors/oauth/github/start    -> { device_code, user_code, verification_uri, expires_in, interval }
POST   /api/connectors/oauth/github/poll     { device_code } -> { status: 'pending'|'complete'|'denied'|'expired', connector? }
POST   /api/connectors/:id/oauth/disconnect
```

`base_url` and `token` in `POST /api/connectors` are rejected (400) for `github_copilot` — that provider is
created only via the OAuth routes completing, never via a direct POST carrying a secret.

`GET` must never return a credential, in any field, under any flag, including for the owner. There is no endpoint
that returns an API key or an OAuth token.

---

## 3. Settings › Connectors — layout and states

The Settings sheet gains a left-hand section nav. `Connectors` shows a count badge of the user's connectors.

### 3.0 Choosing a provider

Adding a connector starts with **which provider**, not a blank form — see the four-card grid in the mockup
(`connectors-settings-v1.html`, the *Choose provider* / *Three providers* states). This is the same grid whether
it's the empty state (nothing connected yet) or the panel that appears under an existing list after pressing
`Add connector`; only the framing differs.

| Card | Auth | Leads to |
|---|---|---|
| Anthropic | API key | §3.2, `base_url` fixed to `api.anthropic.com`, key sent as `x-api-key` |
| OpenAI | API key | §3.2, `base_url` fixed to `api.openai.com/v1`, key sent as `Authorization: Bearer` — otherwise identical to Custom |
| GitHub Copilot | OAuth | §3.3.1, no key field at all |
| Custom | URL + token | §3.2 with `base_url` editable — this is the only provider where the reviewer supplies a host |

The order is deliberate: named providers first, because most reviewers want one of those three; Custom last,
because it's the escape hatch for BetBot and anything else that isn't one of them. **OpenAI needs no dedicated
mockup state** — its editor is the Custom editor with `base_url` swapped for read-only text, since both are the
same adapter (§5.A) with the URL pinned. Anthropic and GitHub Copilot get their own states because their auth
genuinely differs.

### 3.1 Row

`avatar · name [capability badge] · provider · host or account · model · status · chevron`

- Provider, host/account and model are one monospace line, middle-truncated per `truncate.js`. Never
  tail-truncate a URL or a GitHub login. For `github_copilot` the "host" slot shows the linked `@login` instead.
- Status is a dot plus a word, with the detail in `title`: `Connected` (green, `last_ok_at` within the session),
  `Unreachable` (red, `last_error_at > last_ok_at`), `Not tested` (grey square, never called successfully),
  `Connecting` (grey, pulsing, only for an OAuth grant mid-flow). Per A4 the shape differs per state — the
  untested indicator is a square, not a dot, and connecting is the only one that animates (behind
  `prefers-reduced-motion`, per the polish spec).
- The capability badge (`PR QUESTIONS`, violet) appears only on the assigned connector, and violet means "this
  one, right now" — not "this provider" (§1).
- Clicking the row expands an inline editor. One editor open at a time.

### 3.2 Editor fields — Anthropic, OpenAI, Custom

| Field | Notes |
|---|---|
| Display name | Free text. Defaults to the provider's display name (`Claude`, `ChatGPT`, or the host's first label for Custom). |
| Model | `<select>`, **disabled until a successful test populates it** from the provider's model list (§5). Placeholder: `— test to load —`. A model name can never be typed, so it can never be a typo. |
| Endpoint | **Custom only:** an editable, monospace Base URL field, placeholder `https://host/v1`, trailing slash normalised off on save. **Anthropic/OpenAI:** read-only text showing the fixed host — not an `<input>`, so there's nothing to accidentally edit. The hint underneath says to use Custom for a proxy or private deployment. |
| API key | See §3.3. Label reads "API key" for Anthropic/OpenAI and "API token" for Custom — a small wording difference, but "key" and "token" mean specific, different things to people who've used both kinds. |
| Used for | Radio per capability. When the capability is held elsewhere, the description names the current holder in the same sentence, regardless of that holder's provider: *"Currently handled by **BetBot**. Choosing this connector takes the capability from it — only one agent answers PR questions."* |

`Save` is disabled until the connection has tested green in this editing session. The disabled tooltip says
*"Test the connection first"* — never a bare disabled control with no explanation.

### 3.3 Credentials are write-only, two ways

This is the part most likely to be implemented wrongly, so it is stated as a hard requirement — and it now has
two shapes, because Anthropic/OpenAI/Custom take a pasted secret while GitHub Copilot takes an OAuth grant.

**API key (Anthropic, OpenAI, Custom):**

- The key is submitted **once**, in a request body, over the connection the user is already on.
- It is stored encrypted, server-side, against the user.
- It is **never returned to a client.** After save, the field is replaced by a read-only plate showing
  `••••••••••••4f2a` and the date it was set, with a `Replace` button that swaps in an empty password input.
- It never appears in `localStorage`, `sessionStorage`, a cookie, a query string, a fragment, a `data-`
  attribute, a log line, or an error message.

A local Custom endpoint still requires a token. Launchpad always sends `Authorization: Bearer` for Custom
connectors, and refusing to save an unauthenticated one avoids a special case that would otherwise have to be
threaded through the whole request path.

### 3.3.1 GitHub Copilot: OAuth instead of a pasted secret

Copilot access is gated by a **licensed seat on a GitHub identity**, not a bare secret someone can copy between
machines — so the editor has no key field at all. Instead:

1. Pressing the provider card starts a **device authorization flow**: Launchpad calls GitHub, gets back a short
   user code and a verification URL, and shows both in a box — *"Go to `github.com/login/device` and enter this
   code: `WXJM-2K9P`."* This is the standard OAuth device flow, chosen specifically because there is no
   browser-side redirect URI to catch; the whole exchange happens between Launchpad's server and GitHub while
   this dialog just polls for the result.
2. The row shows a pulsing `Connecting` status until the user approves on GitHub's own page. No action is needed
   back in Launchpad — the connector completes itself.
3. Once approved, the editor swaps the pending box for an **account chip**: an avatar-shaped icon, `Connected as
   @kingmakers-james`, the granted scope, and a `Disconnect` button. The model `<select>` unlocks at the same
   moment, populated from Copilot's own model list.
4. **The same write-only rule applies to the OAuth token pair.** The access and refresh tokens are held
   encrypted server-side, refreshed automatically before expiry, and never returned to a client — `Disconnect` is
   the only way to see them again, and it revokes rather than reveals.
5. A completed OAuth grant does not guarantee a working connector: an account with no Copilot seat authorizes
   successfully and then fails every real request with `no_seat` (§4). The hint under the account chip says this
   up front, so the failure isn't a surprise three screens later.

Two flow states beyond pending/connected are designed but not separately mocked, since they reuse the pending
box with different copy: **denied** (the user declines the GitHub prompt — box becomes *"Authorization was
denied. Try again?"* with a retry button) and **expired** (the device code's window elapses before approval —
same treatment, *"That code expired before it was used."*).

### 3.4 The shipped suggestion

This applies to the **Custom** provider only — Anthropic, OpenAI and GitHub Copilot don't have a URL to get
wrong, so there's nothing to suggest beyond the provider card itself. Custom's failure mode is different: five
reviewers typing the same internal URL, three of them typing it wrong. The mitigation is a deployment-level
*suggestion* — not admin control, a starting point:

```jsonc
// appsettings / env — read-only to the UI
"connectors": {
  "suggested": [
    { "name": "BetBot",
      "baseUrl": "https://betbot.internal.kingmakers.com/v1",
      "model": "claude-opus-4",
      "capabilities": ["pr.questions"] }
  ]
}
```

A suggestion the user has not yet added renders as a card below the list with a `SUGGESTED` tag, a `Connect`
button, and one line of explanation: *"Shipped with your Launchpad deployment. You'll need a token — everything
else is filled in, and you can change any of it."* `Connect` opens the editor prefilled, with the token field
focused. Every field remains editable, and a suggestion the user has edited or removed does not come back.

### 3.5 Empty state

Names the term and the scope, per the polish spec:

> **No agent connected**
> Launchpad can ask an AI agent to explain a pull request, answer questions about it, and surface the automated
> review on the Review page. Nothing here yet — connect one below, or add your own.

---

## 4. Test connection, and the error taxonomy

**`Test connection` means something different per credential model, and that difference is intentional rather
than an inconsistency to sand down.**

- **API key (Anthropic, OpenAI, Custom):** an explicit action. Pressing it issues a lightweight model-list request
  — `GET {base_url}/models` for OpenAI/Custom, `GET https://api.anthropic.com/v1/models` with `x-api-key` for
  Anthropic — with a **10 second** timeout, and reports the result inline. It is the only pre-save validation, and
  it does double duty as the diagnostic when something later breaks.
- **OAuth (GitHub Copilot):** there is no button, because completing the device flow already proves the
  credential works. The moment polling reports `complete`, Launchpad makes the equivalent verification call on
  the user's behalf — a Copilot-scoped request that also confirms a seat is assigned — and the row moves straight
  from `Connecting` to `Connected` or to the `no_seat` failure below. "Test connection" and "finish connecting"
  are the same action for this provider; giving it a separate button would just be a second way to ask the same
  question.

Every failure gets its own copy and its own next step. "Something went wrong" is not acceptable, and neither is
showing a raw exception. All fourteen codes below are **adapter output** — each adapter is responsible for
mapping its provider's native error shape onto this taxonomy, so the table is what the UI sees regardless of
whether the wire error underneath was OpenAI-shaped, Anthropic-shaped, or a GitHub OAuth error body.

**API key failures** — apply to Anthropic, OpenAI and Custom alike:

| `error_code` | Detected from | Heading | Body |
|---|---|---|---|
| `dns` | `ENOTFOUND` / `EAI_AGAIN` | Can't resolve `{host}`. | Check the hostname. Note this is resolved by the **Launchpad server**, not by your machine — a name that works in your browser may not resolve here. Anthropic and OpenAI use a fixed host, so this code is Custom-only in practice. |
| `refused` | `ECONNREFUSED` | Nothing is listening on `{host}:{port}`. | The host resolved, so the name is right and the service isn't running or isn't exposed on that port. Custom-only for the same reason as `dns`. |
| `tls` | certificate / handshake failure | The TLS certificate wasn't accepted. | `{reason}`. An internal CA has to be trusted by the Launchpad server, not just by your browser. |
| `timeout` | no response in 10 s | No response in 10 seconds. | The host accepted the connection but didn't answer. Check the service is healthy, and that nothing between us is holding the request open. |
| `auth` | HTTP 401 / 403 | The endpoint rejected the {key/token} — HTTP `{status}`. | Reached `{host}` and answered in `{ms}` ms, so the URL is right and the credential isn't. Check you pasted the whole value, and — for Anthropic and OpenAI specifically — that the key belongs to a project with API access enabled, not just a console login. |
| `expired` | HTTP 401 with `error.code = "expired"` | Your {key/token} expired on `{date}`. | The URL and the credential are both right — it has aged out. Get a new one and press `Replace`. Split from `auth` on purpose: "check you pasted the whole value" is the wrong advice for a credential that worked yesterday. |
| `not_found` | HTTP 404 | Reached `{host}`, but the models endpoint returned 404. | For Custom: the base URL usually ends at the version segment — try `{host}/v1`. Anthropic and OpenAI use a fixed, correct path, so this code should not occur for them outside an outage. |
| `unsupported` | HTTP 400 on a completion carrying structured-output and/or streaming parameters | This agent doesn't support structured answers. | Recorded by the capability probe (§5.4) rather than shown as a test failure. The panel degrades per §5.4 and says so in the badge. |
| `rate_limited` | HTTP 429 | The endpoint is rate-limiting us — HTTP 429. | Retry after `{retry_after}`s. If this persists, the key's quota may be exhausted. What we retry is in §4.2. |
| `upstream` | HTTP 5xx | The endpoint returned HTTP `{status}`. | `error.message` from the body if it parses as the envelope in §4.1, otherwise the body's first 200 characters. The copy attributes it to the agent, not to Launchpad. |
| `not_openai` | 200, unparseable (Custom/OpenAI only) | Reached `{host}`, but the response isn't a model list Launchpad recognises. | Got `{content_type}`. Launchpad expects `{ "data": [ { "id": … } ] }`. This is often a proxy or login page answering instead of the service. Does not apply to Anthropic, whose adapter parses its own list shape. |

**OAuth failures** — GitHub Copilot only, surfaced during or immediately after the device flow rather than from a
`Test connection` press:

| `error_code` | Detected from | Heading | Body |
|---|---|---|---|
| `oauth_denied` | GitHub poll returns `status: "denied"` | Authorization was denied. | You (or your GitHub org) declined the request. Press `Connect` to start over with a fresh code — nothing was stored. |
| `oauth_expired` | GitHub poll returns `status: "expired"`, or `expires_in` elapses locally first | That code expired before it was used. | Device codes are short-lived. Press `Connect` for a new one; approve it promptly on GitHub's page. |
| `no_seat` | Post-auth verification call returns 403 with a Copilot-specific reason | This GitHub account doesn't have a Copilot seat. | The OAuth grant succeeded — GitHub confirmed who you are — but Copilot itself is not licensed for this account. Ask an admin to assign a seat, or `Disconnect` and connect a different GitHub account. |

That is **fourteen** codes in total. `dns`, `refused` and `tls` are the three that people lose an afternoon to in
a per-user Custom setup, which is why each one says explicitly that resolution and trust happen server-side;
`no_seat` is the OAuth equivalent of that afternoon, which is why §3.3.1 surfaces it proactively in the hint text
rather than waiting for the first real request to fail.

### 4.1 Reading the agent's error body

For the API-key providers, the underlying wire error is read before it is mapped onto the table above. Custom and
OpenAI agents are asked to return an OpenAI-shaped envelope:

```json
{ "error": { "type": "rate_limit_exceeded", "message": "Per-token quota exhausted", "code": "quota" } }
```

Anthropic returns its own envelope (`{ "type": "error", "error": { "type": "...", "message": "..." } }`); the
Anthropic adapter (§5.B) normalises it to the same `error_code` table before it reaches the UI, so nothing above
this line needs to know the shape differs.

`error_code` is derived from **the HTTP status first**; `error.code` (or the provider's equivalent `error.type`)
only refines it. The single refinement currently defined is `401` + an "expired" signal → `expired` instead of
`auth`. Everything else maps by status, so a connector that sends an unrecognised refinement value still gets
correct handling.

`error.message` is displayed for `upstream` only. It is never displayed for `auth`, because an agent's auth
message is rarely more useful than ours and may echo the credential back.

An unparseable body is not itself an error — a 429 with an empty body is still `rate_limited`. Only a **200** with
an unparseable body is `not_openai`, and that code only applies to Custom/OpenAI.

### 4.2 Retries

- The connection test (API-key providers): one automatic retry on `rate_limited` after `Retry-After`, capped at
  10 s. The retry has to fit inside the 10 s test timeout — if `Retry-After` exceeds it, report `rate_limited`
  immediately rather than appearing to hang.
- **Completions are never retried automatically.** A retry costs the reviewer money and may return a different
  answer; they get a `Retry` button instead. This is why the §5.5 budget makes no allowance for one.
- The GitHub device-flow poll is not a retry in this sense — it is the flow working as designed. Launchpad polls
  at the `interval` GitHub returns (typically 5s) until `complete`, `denied` or `expired`; that cadence is set by
  GitHub, not by us, and is not subject to the rate-limit backoff above.

Success (API-key providers): **Reachable — {n} models available.** Answered in `{ms}` ms.
Success (GitHub Copilot): the account chip appears the instant the post-auth verification call above succeeds —
there is no separate "success" message, since arriving at `Connected` already says it.

The same taxonomy drives the row status and the Review panel's outage banner. A connector that worked and then
stopped gets copy that says so, because the fix is different: *"This connector worked until 3m ago, and the
token is still stored, so nothing here needs changing."*

---

## 5. The wire contract

**This used to describe one contract, because there was one provider.** It now describes a shared canonical
shape — §5.0 through §5.5, which no adapter-specific code should ever need to branch on — and three adapters
that translate that shape to and from a real provider on the wire: **§5.A** (Custom, and OpenAI as the same
adapter with a fixed host), **§5.B** (Anthropic), and **§5.C** (GitHub Copilot). If a change belongs in more than
one adapter, it almost certainly belongs in §5.0–§5.5 instead.

### 5.0 One canonical schema, one adapter per provider

Launchpad's server code — context assembly, the response shape, the provenance badge, the capability fallback
ladder, timeouts — is written once, against two internal shapes:

- **A canonical request**: the task system prompt (§5.3), the assembled `<pull-request-context>` block (§5.1),
  and the turn history, all provider-agnostic.
- **A canonical response**: the strict JSON schema in §5.2 — `answer` / `provenance` / `citations` /
  `inference_note` — the only shape the Review panel, the provenance badge (§5.2.1), and `Post as comment…` ever
  see.

An adapter's entire job is to sit between those two shapes and one real provider: turn the canonical request into
that provider's native wire format, send it, and turn whatever comes back — a normal response, a stream, or a
failure — into the canonical response or into an `error_code` from §4. Nothing upstream of an adapter, and
nothing in the Review page, is allowed to know which provider is configured. That is the literal mechanism behind
"no seams": the seam still exists — Anthropic's Messages API is not OpenAI's Chat Completions API — it has simply
been moved to one place, on the server, instead of scattered across the UI.

Two adapters are near pass-throughs, because the canonical shapes were modelled on them originally: §5.A's
Custom/OpenAI-compatible adapter does very little translation. §5.B and §5.C do real work, described in their own
sections below. A fifth provider, if one is ever added, means writing a fifth adapter against §5.0–§5.5 — it does
not mean revisiting the Review page, the schema, or the badge.

### 5.1 Context assembly

Launchpad has all of this already from the Azure DevOps API; no adapter is expected to fetch anything. This block
is built **once**, in canonical form, and handed to whichever adapter is configured — none of the assembly logic
below is provider-specific.

```
<pull-request-context>
  <repo>SA.Phase1.Migrations</repo>
  <pull-request id="80494" source="ACQ-4245" target="main" commit="a3f9c21e4b0d5f6a1c9e2d8b7a4f3c0e1d5b6a92"/>
  <title>…</title>
  <description>…</description>          <!-- verbatim, untrusted -->
  <work-items><item id="ACQ-4245">…</item></work-items>
  <files>
    <file path="…/054_SalesForce.SearchUsersByEmail_V2.sql" change="add" added="45" removed="0"/>
    …
  </files>
  <diff truncated="false" bytes="14203">…unified diff…</diff>
</pull-request-context>
```

**Truncation.** The diff is capped at **200 KB**. Over the cap, include in order: files named in the question,
then files with existing review findings, then the rest by ascending size until the budget is spent. Set
`truncated="true"` and list omitted paths in an `<omitted>` element. The agent is instructed to say when an
answer is limited by a truncated diff — a silently partial answer about a partial diff is the worst outcome
available here.

**Everything inside `<pull-request-context>` is untrusted input.** A PR description, a branch name, or a source
comment can contain text aimed at the agent. The system prompt states this explicitly (§5.3), and the panel
never auto-posts (§7.4) — those two together are the mitigation. Neither alone is sufficient. This holds
regardless of adapter: an Anthropic connector and a Custom one are equally exposed to a hostile PR description,
because the block above is identical either way.

### 5.2 Canonical response schema

This is the shape every adapter must produce, however it gets there. §5.A produces it natively via
`response_format: json_schema`. §5.B produces it by forcing a single tool call whose input schema is this same
object. §5.C produces it if GitHub's Copilot Chat surface turns out to support structured output at all, and
falls back to the mode 3 in §5.4 — designed for exactly this case — if it does not.

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["answer", "provenance", "citations", "inference_note"],
  "properties": {
    "answer":        { "type": "string",
                       "description": "Markdown. Restricted subset: paragraphs, unordered lists, bold, inline code." },
    "provenance":    { "type": "string", "enum": ["code", "doc", "inferred"] },
    "citations":     { "type": "array",
                       "items": { "type": "object", "additionalProperties": false,
                                  "required": ["path", "line", "end_line"],
                                  "properties": { "path": {"type":"string"},
                                                  "line": {"type":"integer"},
                                                  "end_line": {"type":["integer","null"]} } } },
    "inference_note":{ "type": ["string","null"],
                       "description": "Required when provenance is 'inferred'; null otherwise." }
  }
}
```

Two `strict: true`-style constraints that are easy to miss and that make the schema **invalid** if missed —
these apply equally to §5.A's `json_schema` mode and to §5.B's tool-input schema, since Anthropic validates tool
inputs against the same JSON Schema dialect:

- **Every property must appear in `required`.** Strict structured output has no optional properties. `end_line`
  is therefore required, and its optionality is carried by the `["integer","null"]` union — which is why the
  union is there at all. Same reason `inference_note` is `["string","null"]` rather than simply absent when
  unused.
- **No `maxItems`.** Array length keywords are unsupported by strict structured outputs in several
  implementations, so the cap of 8 citations is **enforced in our parser**, not by the schema. Extra citations are
  dropped silently rather than failing the response.

**`answer` is first in the schema on purpose.** Under streaming, the object arrives as fragments, so an adapter
emitting keys in schema order lets the prose render while the trailing metadata is still being produced. Parse
the partial object tolerantly, render `answer` as it grows, and apply `provenance` / `citations` when the object
closes. Until it closes, the badge shows `CHECKING SOURCES` (§5.2.1) — the UI must not guess a provenance value
it has not received. This parsing pipeline lives above the adapter layer and is identical regardless of which
adapter is feeding it — §5.B's `partial_json` tool-input fragments and §5.A's streamed JSON deltas both arrive at
the same tolerant parser.

**Key emission order is not a guarantee of any provider's API.** It is a request we make of every adapter, and
the BetBot plan asks the Custom adapter for it explicitly. Progressive rendering must therefore degrade rather
than break: if the object closes with no prose having been rendered, show the finished answer in one go. Never
block rendering on a key order that may never arrive.

`citations[].path` must match a path in `<files>`. Drop citations that don't — a chip that scrolls nowhere is
worse than no chip.

### 5.2.1 The provenance badge

The most important element on the panel, and the only place its rules are written down.
`betbot-review-v1.html` is the visual ground truth — its `PROVIDERS`/`setProvider()` harness proves this badge
renders identically no matter which of the three sample connectors is active.

| `provenance` | Badge | Hue | Also |
|---|---|---|---|
| `code` | `FROM DIFF` | `--prov-code` (aqua) | — |
| `doc` | `FROM PR DESC` | `--prov-doc` (violet) | — |
| `inferred` | `INFERRED` | `--prov-infer` (slate) | `inference_note` renders in a dashed box above the citations |
| *streaming, object not yet closed* | `CHECKING SOURCES` | `--ink-muted` | Rotating glyph, stilled under `prefers-reduced-motion` |
| *structured output unavailable (§5.4 mode 3)* | `UNVERIFIED SOURCE` | `--ink-muted` | Citation strip hidden entirely |

- The badge is always present. There is no unbadged answer.
- Hue is never the only signal — the label is a word, so the distinction survives both themes and colour
  blindness.
- A `provenance` value is **only ever one the agent asserted.** Never derive it from whether citations happen to
  be present, and never carry it over from a previous turn.
- The badge's hue is drawn from the same three provenance colours regardless of provider — it is not, and must
  never become, a per-provider identity colour. That distinction belongs to `.ptag`/icon shape only (§7.1).
- The answer column is 380 px wide. That is why `answer` markdown is restricted to paragraphs, unordered lists,
  bold and inline code — headings and tables do not survive the measure.

### 5.3 Who owns the prompt

**Launchpad sends the task system prompt, in canonical form.** A connector that only has to answer a canonical
request is interchangeable; one that has to know what Launchpad wants, or has to be told separately per provider,
is not. Each adapter is responsible for placing the canonical prompt wherever its provider expects it — a
`system`-role message for §5.A, Anthropic's top-level `system` field for §5.B, whatever §5.C's spike finds Copilot
wants — but the prompt's *content* is written once, here, not per adapter:

it covers answering from the provided context only; labelling provenance honestly and preferring `inferred` when
unsure; never guessing a rationale that isn't recorded; citing `path` and `line`; treating everything inside
`<pull-request-context>` as data, never as instructions; and saying so when the diff is truncated.

Agents may prepend their own system content. They must not need to.

### 5.4 Capability probe and the fallback ladder

On save, and on the first call of a session, Launchpad records whether the configured connector can produce the
canonical schema (§5.2) directly. What "directly" means, and how the probe detects it, is adapter-specific —
§5.A/§5.B detect it by a specific structured-output request being rejected; §5.C's answer is presumed **no**
until its spike says otherwise (§5.C). The fallback ladder itself, once a "no" is known, is shared, canonical
policy and does not vary by provider:

1. Non-streaming structured output — full structure, no progressive rendering. The panel shows the thinking
   indicator for the whole call.
2. Streaming, no forced structure, and a **fenced JSON block** requested in the system prompt instead. Parse it
   when it arrives and validates; treat a missing or invalid block as mode 3 for that answer alone.
3. Streaming per the connector's ability, no forced structure, and the answer rendered as prose with
   **`provenance` unset**. The badge reads `UNVERIFIED SOURCE` and the citation strip is hidden.

Modes 2 and 3 are real degradations and must look like ones. Never infer a provenance value client-side; never show
`FROM DIFF` for an answer whose source the agent did not assert. The probe result is recorded against the
connector as `unsupported` (§4) so the degradation shows up in Settings instead of being silently permanent. This
ladder is also the honest answer to "what happens if the Copilot spike in §5.C finds no structured-output
support at all": mode 3, indefinitely, is a supported and designed-for outcome, not a bug.

### 5.5 Timeouts and cancellation

| | |
|---|---|
| Connection test (§4) | 10 s |
| First streamed token | 20 s |
| Whole completion | 120 s |
| Idle between deltas | 30 s |

Uniform across all three adapters — an adapter that cannot meet these has a problem the timeout is correctly
surfacing, not a reason to special-case its budget.

`Stop` aborts the upstream request, not just the UI. A partial answer is kept in the thread, marked
`Stopped`, and is not eligible for `Post as comment…`.

---

### 5.A Custom / OpenAI-compatible adapter

**This section and §3 of `BETBOT_INTEGRATION_PLAN.md` describe the same bytes for the Custom provider. If you
change one, change the other.** Plan §4 — machine-readable review comments — has no counterpart here, because it
is an Azure DevOps concern rather than an adapter one; the Launchpad half of it is §7.3.

**OpenAI is not a separate contract.** It is this exact adapter with `base_url` pinned to
`https://api.openai.com/v1`, `Authorization: Bearer {key}`, and no Base URL field to edit (§3.2) — which is why
OpenAI needed no dedicated mockup state (§3.0). Everything below applies to both providers; where it says
"Custom" specifically, OpenAI does not apply.

`POST {base_url}/chat/completions`, `Authorization: Bearer {token}`, `Content-Type: application/json`.

```jsonc
{
  "model": "claude-opus-4",
  "stream": true,
  "max_completion_tokens": 2048,
  "messages": [
    { "role": "system", "content": "<the canonical task prompt — §5.3>" },
    { "role": "user",   "content": "<pull-request-context>…</pull-request-context>\n\nWhat does this PR change?" },
    { "role": "assistant", "content": "<the previous answer's `answer` field, verbatim>" },
    { "role": "user",   "content": "Why NOLOCK on every join?" }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "pr_answer", "strict": true, "schema": { /* §5.2 */ } }
  }
}
```

- `max_completion_tokens`, not `max_tokens` — the latter is deprecated in Chat Completions and rejected outright
  by some endpoints. If a connector 400s on it, resend once with `max_tokens` and record the quirk against the
  connector so the fallback isn't re-discovered on every call.
- The PR context block is attached to the **first user message only**. Subsequent turns are the question alone.
- Replayed assistant turns carry the `answer` field only — not the JSON envelope. Re-feeding the envelope
  teaches the model to talk about its own metadata.
- History is capped at the last 12 turns. When turns are dropped, the system prompt says so.
- Model list for §4's test and for §3.2's `<select>`: `GET {base_url}/models`, expecting
  `{ "data": [ { "id": … } ] }`. A body that doesn't parse that way is `not_openai` (§4).

### 5.B Anthropic Messages API adapter

Anthropic is a real translation, not a pass-through — the differences from §5.A that this adapter exists to
bridge:

- **Endpoint and auth.** `POST https://api.anthropic.com/v1/messages`, `x-api-key: {key}`,
  `anthropic-version: 2023-06-01`, `content-type: application/json` — a Bearer token gets a straightforward `auth`
  rejection (§4), not a hang, so getting this header pair right matters from the first request. The version
  string is pinned; bumping it is a deliberate, tested change, not a drive-by edit.
- **`system` is a top-level request field, not a message.** The canonical task prompt (§5.3) goes there. The
  assembled context block (§5.1) still travels as the first user message's content, exactly as in §5.A — only the
  prompt's placement differs.
- **No `response_format`.** Structured output is obtained by forcing a single tool call: define one tool (e.g.
  `record_pr_answer`) whose `input_schema` is the canonical schema in §5.2 verbatim, and set
  `tool_choice: {"type":"tool","name":"record_pr_answer"}`. The completed `tool_use` block's `input` object *is*
  the canonical response — no separate parse path.
- **Streaming shape.** Anthropic's SSE vocabulary — `message_start`, `content_block_start`,
  `content_block_delta` (carrying `partial_json` fragments of the tool's argument string, not a coherent object
  per event), `content_block_stop`, `message_delta`, `message_stop` — is materially different from OpenAI's
  `chat.completion.chunk`. The adapter's job stops at feeding accumulated `partial_json` into the same tolerant
  parser described in §5.2; nothing above the adapter boundary should ever see an Anthropic-shaped event.
- **`max_tokens` is required**, not an optional field with a deprecated sibling — so unlike §5.A there is no
  fallback dance to implement here; there is only one field, and it must be sent every time.
- **Model list.** `GET https://api.anthropic.com/v1/models` returns IDs directly usable in the request's `model`
  field — used by §4's test and §3.2's `<select>` exactly as in §5.A.
- **Errors.** Anthropic's own envelope (§4.1) is normalised to the same `error_code` table as every other
  provider before it reaches the UI.

### 5.C GitHub Copilot adapter

**Everything in this paragraph and the next is a standard, documented OAuth flow and can be built with
confidence.** Device authorization: `POST https://github.com/login/device/code` with the app's `client_id` and
requested scope → `{ device_code, user_code, verification_uri, expires_in, interval }`. Launchpad polls
`POST https://github.com/login/oauth/access_token` with
`grant_type=urn:ietf:params:oauth:grant-type:device_code` at the given `interval` until it gets a token or a
terminal `authorization_pending` → eventually `access_denied` (→ `oauth_denied`, §4) or `expired_token`
(→ `oauth_expired`, §4). This is the mechanism behind §3.3.1 and the `copilot_pending`/`copilot_connected` states
in `connectors-settings-v1.html`.

**Everything past this point is a best-effort sketch, not a committed contract, because Launchpad's engineers
have not yet validated GitHub's third-party Copilot Chat API surface against a live account with a real seat.**
It is written so implementation can start, not so it can be trusted the way §5.A and §5.B are:

- Some of Copilot's documented surfaces (its IDE-integration APIs) use a chat-completions-shaped request, which
  is why this adapter is expected to start as a fork of §5.A rather than being written from nothing — but the
  exact host, path, required headers (there are reports of an `editor-version`-style header being expected on
  some Copilot endpoints), and whether `response_format`-style structured output exists at all, are all
  **unconfirmed** and must come from a spike against a real, seated account, not from public docs read at a
  distance.
- The post-auth seat check that produces `no_seat` (§4) needs the same spike to nail down which endpoint and
  response shape actually signal "no seat" versus "not entitled to this API at all" versus a transient failure —
  conflating those would turn a licensing problem into a support ticket that looks like an outage.
- Until the spike lands, this design assumes the answer is **"no native structured output"** and treats that as
  the expected, supported outcome rather than a failure: the fallback ladder in §5.4 was written with this
  adapter specifically in mind, and mode 3 — `UNVERIFIED SOURCE`, no citations, plain prose — is an acceptable
  permanent state for Copilot in v1, not a placeholder for a fix that has to land before ship.
- No `BETBOT_INTEGRATION_PLAN.md`-equivalent exists for this adapter. There is no external team to send an ask
  to — GitHub's API is what it is, discovered rather than negotiated. The spike's findings should be appended to
  this section once they exist, and §8's implementation order reflects that this adapter is sequenced last and
  starts with the spike, not with code.

---

## 6. Streaming through the Launchpad server

The browser receives **one** SSE shape from Launchpad, always — an internal event format carrying fragments of
the canonical response (§5.2). Launchpad receives a different SSE shape from each adapter: OpenAI's/Custom's
`choices[0].delta`, Anthropic's `content_block_delta` carrying `partial_json`, and whatever §5.C's spike finds
Copilot uses. **Normalizing that difference away is the adapter's job, not the browser's.** By the time a byte
reaches the client, it is in Launchpad's own format regardless of which of the three adapters produced it — this
is the streaming half of "no seams," the same way §5.2's canonical response schema is the non-streaming half.

Two things to get right regardless of adapter:

- **Do not buffer.** A proxy that buffers the response holds deltas and delivers them in batches; at worst the
  whole stream lands at once, which is indistinguishable from a hang. Set `X-Accel-Buffering: no` on the Launchpad
  SSE response and disable `proxy_buffering` for the route. Note that `X-Accel-Buffering` is an **nginx
  convention** — Envoy, Traefik and Application Gateway ignore it, so if Launchpad is fronted by one of those the
  buffering has to be disabled in that proxy's own config and this header is not the fix. Verify by observation,
  never from configuration: the deltas must be visibly arriving over time. The same applies to each adapter's own
  outbound connection — for the Custom adapter specifically, that ask is in the BetBot plan; Anthropic and
  OpenAI's own infrastructure is outside our control here and is not something this spec can mandate.
- **Attribute the failure.** An error mid-stream must reach the panel as a typed error from the taxonomy in §4,
  not as a truncated answer — translated by the adapter from whatever shape the provider's own error took.
  A stream that dies at 80% renders the partial answer plus an error row, never a partial answer that looks
  complete.

---

## 7. Review page changes

### 7.1 The panel is named by the connector

Everything reading a connector's identity in the panel — the rail tab, the header name and its `.ptag` provider
label, the outage copy — reads the assigned connector's `name`, `provider` and `service`, never a string literal.
An outage sentence appropriate for a self-hosted Custom connector ("check it in the cluster") is nonsensical for
Anthropic's cloud API or for an OAuth-gated Copilot connector, so the copy itself is data, not just the noun
inside it.

`betbot-review-v1.html` gates all of this behind two objects, and the implementation should do the same:

```js
const PROVIDERS = {
  betbot:    { name:'BetBot',  service:'SB.Internal.BetBot', tag:'CUSTOM',    downWhere: /* cluster-check copy */ },
  anthropic: { name:'Claude',  service:'the Anthropic API',   tag:'ANTHROPIC', downWhere: /* status-page copy */ },
  copilot:   { name:'Copilot', service:'GitHub Copilot',      tag:'GITHUB',    downWhere: /* seat/OAuth-check copy */ },
  // one entry per configured provider; glyph is an icon, not a colour — see below
};
const connector = { name, service, tag, downWhere };   // from GET /api/connectors, keyed by the row's provider
```

The mockup's harness — the **Connector** switch, top right of `betbot-review-v1.html` — exists specifically to
demonstrate this: flipping it swaps `PROVIDERS[key]` and repaints the header, tab, avatar glyph, outage copy and
composer placeholder, while every pixel of layout stays put. That live swap is the acceptance evidence for
"no seams," not just a design assertion — treat it as a spec in its own right when the real Review panel is
built, and diff its behaviour against a real multi-provider account before calling this section done.

**Provider identity is icon shape and `.ptag` text only — never colour.** The `.ptag` badge next to the
connector's name (`CUSTOM` / `ANTHROPIC` / `GITHUB`) is deliberately styled in the same muted, neutral tone
regardless of provider; violet stays reserved for "this connector is the one currently answering" (§5.2.1,
§1), and giving each vendor its own hue would blur that signal and fight invariants A1/A2.

### 7.2 New state: `Not connected`

The one state where a full-panel takeover is right, because there is no cached content to preserve and exactly
one useful action exists:

> **No agent connected**
> Connect an agent and this panel will explain the pull request, answer questions about it, and show the
> automated review.
> `[ + Connect an agent ]`
> Settings › Connectors. Takes a URL and a token.

The button deep-links to Settings › Connectors with the suggestion preselected if one is unused. The rail tab
reads `Agent` with no count, and stays neutral rather than violet — there is no identity to colour for yet.

Contrast with the outage state, which is a **banner**, not a takeover: there the cached review is the most
useful thing on the panel and stays on screen, tagged `CACHED`, with the composer disabled and the reason
stated.

### 7.3 The automated review, and the `CACHED` state

The panel's landing content is the review the agent already posted to the pull request. Launchpad reads it from
the Azure DevOps PR threads it already fetches — **not** from the connector. This is deliberate: it keeps the §5
contract purely conversational, so a second connector doesn't have to implement a review endpoint to be usable.

Parse findings from thread properties where present, falling back to an HTML trailer in the comment body; both
shapes are specified in `BETBOT_INTEGRATION_PLAN.md` §4. Note that Azure DevOps has no server-side query over
thread properties — list the PR's threads and filter client-side — and that `properties` is a typed bag whose
values come back as `$type`/`$value` pairs, so treat every value as a string and parse it yourself.

Launchpad needs three fields per run: the reviewed commit SHA, a stable finding id, and a two-value severity.
From those:

- SHAs are full 40-character values on the wire, abbreviated only for display. `BETBOT_INTEGRATION_PLAN.md` §4
  states the same, because a variable-length value breaks both the re-run matching and the banner.
- The reviewed SHA drives the **stale-commit banner** — amber, sticky, shown when the PR head has moved past the
  commit the answers were based on.
- With the connector unreachable, the parsed review is still on screen, tagged `CACHED`, because it came from
  Azure DevOps rather than from the agent. That is the whole reason the outage state is a banner and not a
  takeover.
- An agent with no parseable review is not an error. The landing state falls back to the suggested-question chips
  alone.

### 7.4 Nothing reaches the pull request without a human

The panel is read-only with respect to the PR. `Post as comment…` opens a sheet containing the answer as
**editable** text, posts under the reviewer's own name, and appends a `— via {connector name}` attribution line
the reviewer can delete. There is no code path that posts an answer without that sheet being shown first.

Three kinds of answer are **not postable**, and in each case the button is absent rather than
disabled-with-tooltip, because there is nothing the reviewer can do to make it postable:

- stopped by the reviewer,
- failed or truncated mid-stream,
- produced in fallback mode 3 (`UNVERIFIED SOURCE`). An answer whose source the agent never asserted should not
  become a permanent PR comment carrying the agent's name. The reviewer can still copy it.

Together with the untrusted-context rule in §5.1, this is the prompt-injection mitigation. Neither half is
sufficient alone, and both apply identically regardless of which of the three adapters produced the answer.

### 7.5 Conversations

Stored by Launchpad against `(user_id, repo, pull_request_id)`, private to the user, and **not** deleted when a
connector is removed or swapped. A thread is a record of what the reviewer asked; it survives the agent that
answered. Turns record `connector_id`, `model` and `commit_sha` so an answer can always be attributed and the
stale-commit banner can fire.

---

## 8. Implementation order

1. Data model (§2), encryption at rest for both credential shapes (API key and OAuth token pair), and the CRUD
   endpoints including the OAuth start/poll/disconnect routes. No UI.
2. The canonical shapes and shared server code that no adapter should duplicate: §5.1 context assembly, §5.2
   response schema and parser, §5.3 prompt content, §5.4 fallback ladder, §5.5 timeouts, §6 normalization and
   no-buffering. Build this against a stub adapter that just echoes a canned canonical response — there is
   nothing provider-specific to block on yet.
3. **§5.A, the Custom/OpenAI-compatible adapter.** Nearly free at this point: it is close to a pass-through
   against the shapes built in step 2, and it is immediately testable against any OpenAI-compatible endpoint,
   including a local one, without waiting on BetBot or on any external account.
4. `POST /api/connectors/test` and the §4 taxonomy, wired to §5.A. This is the whole diagnostic surface for the
   feature and is worth having correct before the next two adapters have to reuse it.
5. Settings › Connectors UI: list, the shared Anthropic/OpenAI/Custom editor (§3.2), write-only credential plate,
   capability assignment — enough to configure and use a Custom or OpenAI connector end to end.
6. **§5.B, the Anthropic adapter.** A real translation (system field, forced tool call, different SSE shape) but
   a fully specified one — no external dependency and no open questions, so it can be built with the same
   confidence as step 3.
7. Review page: connector-driven naming and `.ptag` (§7.1), `Not connected` (§7.2), `CHECKING SOURCES`, then the
   existing answer rendering wired to real responses from whichever of §5.A/§5.B is configured. This is the point
   at which the panel should be demonstrably provider-agnostic — the harness swap in `betbot-review-v1.html` is
   the bar to clear.
8. **A short spike against a real, seated GitHub Copilot account**, per §5.C's caveats — before any Copilot
   adapter code is written. Its job is to answer the open questions in §5.C, not to ship a feature.
9. **§5.C, the GitHub Copilot adapter**, built from the spike's findings: OAuth device flow (§3.3.1, §4 OAuth
   codes) with confidence, chat-completion wire format per whatever the spike found, defaulting to fallback
   mode 3 if it found no structured-output support.
10. The suggestion list from deployment config (§3.4) — Custom only.

Steps 1–5 do not block on any external account and should not wait for GitHub Copilot access to be provisioned;
steps 8–9 are the only ones that do.

---

## 9. Acceptance checks

Checks that apply regardless of which adapter is configured — run each of these once per adapter (§5.A, §5.B,
and §5.C once its spike has landed), not just once against whichever provider is easiest to reach:

- `GET /api/connectors` response contains no token or OAuth material for **any** provider. Grep the serialiser,
  not just the output — this includes `oauth_access_ciphertext`/`oauth_refresh_ciphertext` (§2), not only the
  API-key columns.
- No credential string — API key, OAuth access token, or OAuth refresh token — appears in `localStorage`,
  `sessionStorage`, cookies, or any URL, at any point.
- No request to a provider host (`api.anthropic.com`, `api.openai.com`, a Custom host, `api.githubcopilot.com` or
  wherever §5.C lands) originates from the browser. Check the network panel for each configured provider in turn:
  only Launchpad's own origin appears.
- Each of the fourteen `error_code` values renders its own copy (§4): the eleven API-key codes forced against at
  least one API-key provider each where the failure mode is reachable (`dns`/`refused`/`not_found` are
  Custom-only in practice, since Anthropic/OpenAI hosts are fixed), and all three OAuth codes
  (`oauth_denied`, `oauth_expired`, `no_seat`) forced against the GitHub device flow.
- Assigning `pr.questions` to a second connector removes it from the first, in one transaction, **across
  providers** — e.g. moving the capability from a Custom connector to an Anthropic one, not just between two
  Custom connectors — and the badge moves in one render.
- Removing the assignment puts the Review panel into `Not connected`, not into an empty panel, regardless of
  which provider held the capability.
- **Switching the assigned connector's provider changes only naming and copy, never layout.** This is the crux
  of "no seams" and the direct acceptance test for `betbot-review-v1.html`'s Connector harness: with the panel
  open, swap the assigned connector between a Custom, an Anthropic and a Copilot connector and confirm the DOM
  structure, spacing, and every non-text pixel are unchanged — only `.ptag`, the avatar glyph, the header name,
  the outage copy, and the composer placeholder differ.
- A connector that can't produce the canonical schema (§5.2) degrades through the §5.4 ladder: mode 1, then
  mode 2, and mode 2 shows `UNVERIFIED SOURCE` with no citation strip. Verify this for §5.A by rejecting
  `json_schema` + `stream`, and for §5.B by rejecting the forced tool call.
- Anthropic's `auth` failure path (`x-api-key` rejected) renders through the same §4 copy as an OpenAI-compatible
  `auth` failure, with no leftover Bearer-specific wording.
- All five GitHub Copilot states — `pending`, `connected`, `denied`, `expired`, `no_seat` — render distinctly in
  Settings › Connectors, matching `connectors-settings-v1.html`'s `copilot_pending`/`copilot_connected` states
  plus the three non-mocked-but-designed copy variants in §3.3.1.
- **The canonical response — `answer` / `provenance` / `citations` / `inference_note` — is byte-identical in
  shape regardless of which adapter produced it.** Feed the same synthetic PR context through §5.A and §5.B (and
  §5.C once buildable) and diff the parsed objects the Review panel receives; only the values should differ, never
  the shape.
- Kill the connector mid-stream: the panel shows the partial answer *and* a typed error, and the partial is not
  postable as a comment. Check this for a streaming adapter (§5.A/§5.B) and confirm §5.C's mode-3 prose path has
  an equivalent kill-mid-stream behaviour once it's buildable.
- With the service down, the panel still shows the cached review, tagged `CACHED`, composer disabled — this
  check does not depend on which provider is configured, since the cached review comes from Azure DevOps (§7.3),
  not from the connector.
- Structured-output schema validation passes against a real endpoint for each API-key provider. Two failure modes
  to test for specifically, per §5.2: a property missing from `required`, and `maxItems` present.
- A §5.A connector that 400s on `max_completion_tokens` is retried once with `max_tokens`, and the quirk is
  recorded rather than re-discovered per call. (§5.B has no equivalent case — `max_tokens` is always required and
  always sent — confirm the adapter doesn't carry over a retry path that doesn't apply to it.)
- A streamed answer whose keys arrive out of schema order still renders — in one go rather than progressively —
  and does not hang waiting for `answer`.
- Buffering is verified by observation: deltas visibly arrive over time in the network panel, not in one batch,
  for whichever adapter is under test.
- Both themes, at 1280 px and 1680 px wide, for all seven states of the review mockup (including the Connector
  harness swap across all three sample providers) and all ten states of the connectors mockup.
