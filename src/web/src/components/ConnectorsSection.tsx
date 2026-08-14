import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Connector, ConnectorProvider, ProbeResult } from "../types";
import { HEAD_RATIO_BALANCED } from "../lib/truncate";
import { Truncated } from "./Truncated";

const PR_QUESTIONS = "pr.questions";

/**
 * Settings › Connectors (DESIGN_SPEC_CONNECTORS.md §3).
 *
 * Nothing here names a provider in a string literal — the picker, the labels and the credential
 * wording all come from `/api/connector-providers`, so the server stays the single source of truth
 * for which providers exist and what each one needs.
 */
export function ConnectorsSection() {
  const qc = useQueryClient();
  const connectorsQ = useQuery<Connector[]>({ queryKey: ["connectors"], queryFn: api.connectors });
  const providersQ = useQuery<ConnectorProvider[]>({
    queryKey: ["connector-providers"],
    queryFn: api.connectorProviders,
  });

  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<ConnectorProvider | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const connectors = connectorsQ.data ?? [];
  const providers = providersQ.data ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["connectors"] });

  const holder = connectors.find((c) => c.capabilities.includes(PR_QUESTIONS));

  return (
    <div className="field">
      <div className="cx-head">
        <div>
          <label className="label" style={{ marginBottom: 4 }}>Connectors</label>
          <div className="faint cx-lede">
            Agents Launchpad can talk to. Connectors are <b>yours</b> — credentials are stored
            against your account, and questions you ask are attributed to you rather than to a
            shared service identity.
          </div>
        </div>
        {connectors.length > 0 && !adding && (
          <button className="btn small" onClick={() => setPicking((p) => !p)}>
            + Add connector
          </button>
        )}
      </div>

      {/* Nothing connected: the picker doubles as the empty state (§3.5), which names the term and
          says what connecting one buys you rather than just reporting emptiness. */}
      {!connectorsQ.isLoading && connectors.length === 0 && !adding && (
        <div className="cx-empty">
          <b>No agent connected</b>
          <p>
            Launchpad can ask an AI agent to explain a pull request and answer questions about it on
            the Review page. Connect one below — an API key for Anthropic or OpenAI, or a URL and
            token for anything else that speaks the same protocol.
          </p>
        </div>
      )}

      {connectors.length > 0 && (
        <div className="cx-list">
          {connectors.map((c) => (
            <ConnectorRow
              key={c.id}
              connector={c}
              provider={providers.find((p) => p.key === c.provider)}
              holderName={holder && holder.id !== c.id ? holder.name : null}
              open={openId === c.id}
              onToggle={() => setOpenId(openId === c.id ? null : c.id)}
              onChanged={invalidate}
              onRemoved={() => { setOpenId(null); invalidate(); }}
            />
          ))}
        </div>
      )}

      {/* Provider first, not URL first (§3.0): the honest answer to "what do I need to paste" is
          different per provider, and hiding that behind one generic form creates the seam rather
          than removing it. */}
      {(picking || (connectors.length === 0 && !adding)) && (
        <div className="cx-pick">
          {connectors.length > 0 && <div className="cx-pick-h">Add a connector</div>}
          <div className="cx-grid">
            {providers.map((p) => (
              <button
                key={p.key}
                className="cx-card"
                onClick={() => { setAdding(p); setPicking(false); setOpenId(null); }}
              >
                <span className="cx-card-n">{p.displayName}</span>
                <span className="cx-card-d">
                  {p.urlEditable
                    ? "Any OpenAI-compatible endpoint — an in-house agent, or a local model."
                    /* The label keeps the server's casing: "API key" is an initialism, and
                       lowercasing it produced "an api key". */
                    : `Direct. Paste ${/^[AEIOU]/i.test(p.credentialLabel) ? "an" : "a"} ${p.credentialLabel} issued from your account.`}
                </span>
                <span className="cx-card-a">
                  {p.urlEditable ? "URL + token" : p.credentialLabel}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {adding && (
        <ConnectorEditor
          provider={adding}
          holderName={holder?.name ?? null}
          onCancel={() => setAdding(null)}
          onSaved={() => { setAdding(null); invalidate(); }}
        />
      )}

      <div className="cx-foot">
        <b>Launchpad's server makes every call to a connector; your browser never does.</b>{" "}
        Conversations on the Review page are stored against you and the pull request, and are not
        visible to other reviewers.
      </div>
    </div>
  );
}

/** §3.1 — avatar-less row: name, capability badge, provider·host·model, status, chevron. */
function ConnectorRow({
  connector, provider, holderName, open, onToggle, onChanged, onRemoved,
}: {
  connector: Connector;
  provider?: ConnectorProvider;
  holderName: string | null;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const host = connector.baseUrl?.replace(/^https?:\/\//, "") ?? connector.oauthLogin ?? "";
  const sub = [provider?.displayName ?? connector.provider, host, connector.model]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className={`cx-row ${open ? "open" : ""}`} onClick={onToggle}>
        <div className="cx-main">
          <div className="cx-name">
            {connector.name}
            {connector.capabilities.includes(PR_QUESTIONS) && (
              <span className="cx-assigned">PR QUESTIONS</span>
            )}
          </div>
          {/* Never tail-truncate a URL — the distinguishing part is the end. */}
          <Truncated className="cx-sub" text={sub} headRatio={HEAD_RATIO_BALANCED} />
        </div>
        <StatusPip connector={connector} />
        <svg className="cx-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="M6 3.5l5 4.5-5 4.5" />
        </svg>
      </div>

      {open && (
        <ConnectorEditor
          provider={provider}
          existing={connector}
          holderName={holderName}
          onCancel={onToggle}
          onSaved={onChanged}
          onRemoved={onRemoved}
        />
      )}
    </>
  );
}

/**
 * §3.1's four states, each with its own shape as well as its own hue (A4): a filled dot for
 * connected, a filled dot in the bad hue for unreachable, a hollow square for never-tested, and a
 * pulsing dot for an OAuth grant mid-flow. The word is always present, so hue is never the only
 * signal.
 */
function StatusPip({ connector }: { connector: Connector }) {
  const { status, lastErrorCode } = connector;
  const label = status === "connected" ? "Connected"
    : status === "unreachable" ? "Unreachable"
    : status === "connecting" ? "Connecting"
    : "Not tested";

  const title = status === "unreachable" && lastErrorCode
    ? `Last call failed — ${lastErrorCode}`
    : status === "connected" ? "Last call succeeded"
    : status === "not_tested" ? "Never tested successfully"
    : "Waiting for authorization";

  return (
    <span className={`cx-st ${status}`} title={title}>
      <span className="cx-dot" />
      {label}
    </span>
  );
}

/** §3.2 — the shared editor for the API-key providers. */
function ConnectorEditor({
  provider, existing, holderName, onCancel, onSaved, onRemoved,
}: {
  provider?: ConnectorProvider;
  existing?: Connector;
  holderName: string | null;
  onCancel: () => void;
  onSaved: () => void;
  onRemoved?: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? provider?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(!existing);
  const [model, setModel] = useState(existing?.model ?? "");
  const [assigned, setAssigned] = useState(existing?.capabilities.includes(PR_QUESTIONS) ?? true);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const urlEditable = provider?.urlEditable ?? false;
  const credentialLabel = provider?.credentialLabel ?? "API token";

  /**
   * §3.2: the model list is earned, not typed. It is only populated by a successful test — so a
   * saved connector shows its stored model until one is run, and a new one shows nothing at all.
   */
  const models = useMemo(() => {
    if (probe?.ok) return probe.models;
    return existing?.model ? [existing.model] : [];
  }, [probe, existing?.model]);

  const testedGreen = probe?.ok === true;
  // A saved connector can be saved again without retesting — its credential already worked. A new
  // one cannot: that is what stops a typo becoming a stored connector.
  const canSave = existing ? true : testedGreen && !!model;

  const test = useMutation({
    mutationFn: async () => {
      setError(null);
      if (existing && !replacing) return api.testSavedConnector(existing.id);
      return api.testConnector({
        provider: provider?.key ?? existing?.provider ?? "",
        baseUrl: urlEditable ? baseUrl.trim() : undefined,
        token: token.trim(),
      });
    },
    onSuccess: (result) => {
      setProbe(result);
      // Adopt the first reported model only when the current one isn't in the list, so a test never
      // silently changes a deliberate choice.
      if (result.ok && result.models.length > 0 && !result.models.includes(model)) {
        setModel(result.models[0]);
      }
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "The test could not be run."),
  });

  const save = useMutation({
    mutationFn: async () => {
      setError(null);
      const capabilities = assigned ? [PR_QUESTIONS] : [];
      if (existing) {
        return api.patchConnector(existing.id, {
          name: name.trim(),
          model: model.trim(),
          baseUrl: urlEditable ? baseUrl.trim() : undefined,
          // Omitted unless deliberately replaced, so saving a rename never disturbs the credential.
          token: replacing && token.trim() ? token.trim() : undefined,
          capabilities,
        });
      }
      return api.addConnector({
        provider: provider!.key,
        name: name.trim(),
        baseUrl: urlEditable ? baseUrl.trim() : undefined,
        model: model.trim(),
        token: token.trim(),
        capabilities,
      });
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : "The connector could not be saved."),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteConnector(existing!.id),
    onSuccess: () => onRemoved?.(),
    onError: (e) => setError(e instanceof ApiError ? e.message : "The connector could not be removed."),
  });

  return (
    <div className="cx-editor">
      <div className="cx-frow">
        <div className="cx-f">
          <label className="cx-l">Display name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <p className="cx-hint">Shown on the Review page. It doesn't have to match the service name.</p>
        </div>
        <div className="cx-f narrow">
          <label className="cx-l">Model</label>
          <select
            className="select"
            value={model}
            disabled={models.length === 0}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.length === 0 && <option value="">— test to load —</option>}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <p className="cx-hint">Loaded from the provider's own model list, so a typo can't be saved.</p>
        </div>
      </div>

      <div className="cx-frow">
        <div className="cx-f">
          <label className="cx-l">{urlEditable ? "Base URL" : "Endpoint"}</label>
          {urlEditable ? (
            <>
              <input
                className="input mono"
                placeholder="https://host/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <p className="cx-hint">
                Resolved from the <b>Launchpad server</b>, not from your machine — so an internal
                hostname has to resolve there, and a <code>127.0.0.1</code> URL means the server's
                own loopback.
              </p>
            </>
          ) : (
            <>
              {/* Read-only text rather than a disabled input: there is nothing to edit, so there
                  should be nothing that looks like a field (§3.2). */}
              <div className="cx-fixed mono">
                {(provider?.fixedBaseUrl ?? existing?.baseUrl ?? "").replace(/^https?:\/\//, "")}
              </div>
              <p className="cx-hint">
                Fixed per provider. Use a custom connector if you need a different host, such as a
                proxy or a private deployment.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="cx-frow">
        <div className="cx-f">
          <label className="cx-l">{credentialLabel}</label>
          {existing && !replacing ? (
            <div className="cx-tokrow">
              {/* §3.3: after saving there is only ever a last-four plate. The value is never
                  returned to this page, so it cannot be read back out of the browser. */}
              <div className="cx-stored mono">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
                  aria-hidden="true" style={{ width: 12, height: 12 }}>
                  <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
                  <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
                </svg>
                ••••••••••••{existing.tokenLast4}
                {existing.tokenSetAt && (
                  <span className="cx-age">
                    added {new Date(existing.tokenSetAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              <button className="btn small" onClick={() => { setReplacing(true); setProbe(null); }}>
                Replace
              </button>
            </div>
          ) : (
            <div className="cx-tokrow">
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                placeholder={`Paste the ${credentialLabel}`}
                value={token}
                onChange={(e) => { setToken(e.target.value); setProbe(null); }}
              />
              {existing && (
                <button className="btn small" onClick={() => { setReplacing(false); setToken(""); }}>
                  Cancel
                </button>
              )}
            </div>
          )}
          <p className="cx-hint">
            Held on the Launchpad server against your account and sent only to the endpoint above.
            It is never returned to this page, so it can't be read back out of the browser.
          </p>
        </div>
      </div>

      {probe && <ProbeBanner probe={probe} />}
      {error && <div className="error" style={{ fontSize: 12, marginTop: 10 }}>{error}</div>}

      <div className="cx-caps">
        <div className="cx-l">Used for</div>
        <label className="cx-cap">
          <input type="checkbox" checked={assigned} onChange={(e) => setAssigned(e.target.checked)} />
          <span>
            Answering questions on the Review page
            {/* §3.2: when the capability is held elsewhere, name the current holder in the same
                sentence — so taking it is a decision rather than a surprise. */}
            <span className="cx-cd">
              {holderName
                ? <>Currently handled by <b>{holderName}</b>. Choosing this connector takes the
                    capability from it — only one agent answers PR questions.</>
                : assigned
                  ? <>This connector will answer questions on the Review page.</>
                  : <>Nothing will answer questions, and the panel will read <b>Not connected</b>.</>}
            </span>
          </span>
        </label>
      </div>

      <div className="cx-efoot">
        <button
          className="btn small"
          disabled={test.isPending || (replacing && !token.trim())}
          onClick={() => test.mutate()}
        >
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
        <span style={{ marginLeft: "auto" }} />
        {existing && (
          <button className="btn small cx-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </button>
        )}
        <button className="btn small" onClick={onCancel}>Cancel</button>
        <button
          className="btn small primary"
          disabled={!canSave || save.isPending}
          title={canSave ? undefined : "Test the connection first"}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : existing ? "Save" : "Save connector"}
        </button>
      </div>
    </div>
  );
}

/**
 * The §4 result, inline.
 *
 * Every failure gets its own copy and its own next step — "something went wrong" is a defect, and
 * so is raw exception text. The three that people lose an afternoon to say explicitly that
 * resolution and certificate trust happen on the Launchpad server, not on the reviewer's machine.
 */
function ProbeBanner({ probe }: { probe: ProbeResult }) {
  if (probe.ok) {
    return (
      <div className="cx-result pass">
        <div>
          <b>Reachable — {probe.models.length} model{probe.models.length === 1 ? "" : "s"} available.</b>{" "}
          Answered in {probe.latencyMs}&nbsp;ms.
        </div>
      </div>
    );
  }

  const { errorCode, httpStatus, detail, retryAfterSeconds } = probe;
  const copy = ((): { head: string; body: React.ReactNode } => {
    switch (errorCode) {
      case "dns":
        return {
          head: `Can't resolve ${detail ?? "that host"}.`,
          body: <>Check the hostname. This is resolved by the <b>Launchpad server</b>, not by your
            machine — a name that works in your browser may not resolve here.</>,
        };
      case "refused":
        return {
          head: `Nothing is listening on ${detail ?? "that host"}.`,
          body: <>The host resolved, so the name is right and the service either isn't running or
            isn't exposed on that port.</>,
        };
      case "tls":
        return {
          head: "The TLS certificate wasn't accepted.",
          body: <>{detail} An internal CA has to be trusted by the <b>Launchpad server</b>, not just
            by your browser.</>,
        };
      case "timeout":
        return {
          head: "No response in 10 seconds.",
          body: <>The host accepted the connection but didn't answer. Check the service is healthy,
            and that nothing between us is holding the request open.</>,
        };
      case "auth":
        return {
          head: `The endpoint rejected the credential — HTTP ${httpStatus ?? 401}.`,
          body: <>It reached the host and answered in {probe.latencyMs}&nbsp;ms, so the URL is right
            and the credential isn't. Check you pasted the whole value, and that it belongs to an
            account with API access enabled rather than just a console login.</>,
        };
      case "expired":
        return {
          head: "That credential has expired.",
          body: <>The URL and the credential are both right — it has aged out. Get a new one and
            press <b>Replace</b>.</>,
        };
      case "not_found":
        return {
          head: `Reached the host, but the models endpoint returned ${httpStatus ?? 404}.`,
          body: <>A base URL usually ends at the version segment — try adding <code>/v1</code>.</>,
        };
      case "rate_limited":
        return {
          head: "The endpoint is rate-limiting us — HTTP 429.",
          body: <>{retryAfterSeconds ? <>Retry after {retryAfterSeconds}s.</> : <>Retry shortly.</>}{" "}
            If this persists, the credential's quota may be exhausted.</>,
        };
      case "not_openai":
        return {
          head: "That response isn't a model list Launchpad recognises.",
          body: <>This is often a proxy or a login page answering instead of the service.</>,
        };
      case "unsupported":
        return {
          head: "This agent doesn't support structured answers.",
          body: <>It will still answer questions, but without stating where each answer came
            from — the panel will say so.</>,
        };
      default:
        return {
          head: `The endpoint returned HTTP ${httpStatus ?? "an error"}.`,
          body: <>{detail ?? "No further detail was returned."}</>,
        };
    }
  })();

  return (
    <div className="cx-result fail">
      <div><b>{copy.head}</b> {copy.body}</div>
    </div>
  );
}
