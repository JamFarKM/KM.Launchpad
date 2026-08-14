import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { askAgent } from "../lib/askAgent";
import type { AgentCitation, AgentTurn, Connector, ConnectorProvider, PullRequest } from "../types";

const PR_QUESTIONS = "pr.questions";

const SUGGESTIONS = [
  "What does this PR change?",
  "What breaks if I approve this?",
  "Is anything here not covered by tests?",
];

interface Props {
  project: string;
  repoId: string;
  pr: PullRequest;
  /** Scroll the diff to a cited line, switching file first if the citation is elsewhere. */
  onCite: (path: string, line: number) => void;
  /** Prefilled from the diff gutter's ask action, so a question can be scoped to a line. */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
}

/**
 * The agent panel on the Review page (DESIGN_SPEC_CONNECTORS.md §7).
 *
 * <b>Nothing here names a provider or an agent.</b> The header, the tab label, the composer
 * placeholder and the outage copy all read the assigned connector's own `name` — which is why a
 * connector called "BetBot" that happens to be Anthropic underneath reads as BetBot throughout,
 * and why swapping the provider changes only text.
 */
export function AgentPanel({ project, repoId, pr, onCite, prefill, onPrefillConsumed }: Props) {
  const connectorsQ = useQuery<Connector[]>({ queryKey: ["connectors"], queryFn: api.connectors });
  const providersQ = useQuery<ConnectorProvider[]>({
    queryKey: ["connector-providers"],
    queryFn: api.connectorProviders,
  });

  const threadQ = useQuery({
    queryKey: ["agent-thread", project, repoId, pr.id],
    queryFn: () => api.agentThread(project, repoId, pr.id),
  });

  const connector = connectorsQ.data?.find((c) => c.capabilities.includes(PR_QUESTIONS)) ?? null;
  const provider = providersQ.data?.find((p) => p.key === connector?.provider);

  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamed, setStreamed] = useState("");
  const [failure, setFailure] = useState<{ code: string; detail?: string | null } | null>(null);
  const [truncation, setTruncation] = useState<{ omitted: string[] } | null>(null);
  const [posting, setPosting] = useState<AgentTurn | null>(null);

  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Server-recorded turns are the source of truth; local state mirrors them so a stream can render
  // before the query refetches.
  useEffect(() => { if (threadQ.data) setTurns(threadQ.data.turns); }, [threadQ.data]);

  useEffect(() => {
    if (prefill) { setQuestion(prefill); onPrefillConsumed?.(); }
  }, [prefill, onPrefillConsumed]);

  // §7's panel auto-scrolls to the newest answer.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [turns.length, streamed]);

  useEffect(() => () => abort.current?.abort(), []);

  /**
   * The stale-commit banner (§7.3): the newest turn was answered against a commit the PR head has
   * since moved past. Compared per turn rather than per thread, because a thread outlives pushes.
   */
  const stale = useMemo(() => {
    const last = turns.length ? turns[turns.length - 1] : undefined;
    if (!last?.commitSha || !pr.sourceCommit) return null;
    return last.commitSha === pr.sourceCommit ? null : { answered: last.commitSha, head: pr.sourceCommit };
  }, [turns, pr.sourceCommit]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || streaming || !connector) return;

    setQuestion("");
    setStreamed("");
    setFailure(null);
    setTruncation(null);
    setStreaming(true);

    const controller = new AbortController();
    abort.current = controller;

    try {
      await askAgent(project, repoId, pr.id, q, {
        onContext: (info) => { if (info.truncated) setTruncation({ omitted: info.omitted }); },
        onDelta: (text) => setStreamed((s) => s + text),
        onComplete: (turn) => { setTurns((t) => [...t, turn]); setStreamed(""); },
        onError: (e) => setFailure(e),
      }, controller.signal);
    } catch (e) {
      // An abort is the reviewer pressing Stop — the server keeps the partial and marks it
      // Stopped (§5.5), so the refetch below will show it. Anything else is a real failure.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setFailure({ code: "upstream", detail: "The request could not be completed." });
      }
    } finally {
      setStreaming(false);
      abort.current = null;
      threadQ.refetch();
    }
  }

  // §7.2 — the one state where a full-panel takeover is right: nothing to preserve, and exactly
  // one useful action.
  if (!connectorsQ.isLoading && !connector) {
    return (
      <div className="ag-noconn">
        <b>No agent connected</b>
        <p>
          Connect an agent and this panel will explain the pull request and answer questions
          about it.
        </p>
        <p className="ag-fine">Settings › Connectors. Takes a credential, and a URL for your own endpoint.</p>
      </div>
    );
  }

  const name = connector?.name ?? "Agent";
  const unreachable = connector?.status === "unreachable";

  return (
    <>
      <div className="ag-head">
        <div className="ag-id">
          <div className="ag-name">
            {name}
            {/* Provider identity is text and never colour — violet stays reserved for "this is the
                connector answering right now" (§7.1). */}
            {provider && <span className="ag-ptag">{provider.key.replace("_", " ").toUpperCase()}</span>}
          </div>
          <div className="ag-meta">{connector?.model ?? ""}</div>
        </div>
      </div>

      <div className="ag-scroll" ref={scroller}>
        {/* An outage is a banner, not a takeover — the thread below it is still the most useful
            thing on the panel, so it stays on screen with the reason stated. There is no cached
            automated review to keep yet, so the copy says what is actually true rather than
            pointing at findings that do not exist. */}
        {unreachable && (
          <div className="ag-banner ag-down">
            <div>
              <b>{name} wasn't reachable on the last attempt.</b> Earlier answers are below and stay
              readable. New questions may fail until it's back.
              {connector?.lastErrorCode && <> Last error: <code>{connector.lastErrorCode}</code>.</>}
            </div>
          </div>
        )}

        {stale && (
          <div className="ag-banner ag-stale">
            <div>
              <b>Answered against an older commit.</b> This thread is about{" "}
              <code>{stale.answered.slice(0, 7)}</code>; the head is now{" "}
              <code>{stale.head.slice(0, 7)}</code>. Ask again to answer on the new commit.
            </div>
          </div>
        )}

        {turns.length === 0 && !streaming && (
          <>
            <div className="ag-slabel">Ask about this PR</div>
            <div className="ag-chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="ag-chip" onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </>
        )}

        {turns.map((t) => (
          <Turn key={t.id} turn={t} onCite={onCite} onPost={() => setPosting(t)} />
        ))}

        {streaming && (
          <div className="ag-turn">
            <div className="ag-you">{/* the question is already in the thread once complete */}</div>
            <div className="ag-answer">
              <div className="ag-ahead">
                <span className="ag-who">{name.toUpperCase()}</span>
                {/* Nothing has been asserted yet, so the badge says it is still looking rather than
                    claiming a source in advance (§5.2.1). */}
                <span className="ag-prov pending" title="The source is stated once the answer lands.">
                  CHECKING SOURCES
                </span>
              </div>
              {streamed
                ? <Markdown text={streamed} />
                : <div className="ag-thinking">reading the diff and the description…</div>}
              <div className="ag-afoot">
                <button className="ag-mini" onClick={() => abort.current?.abort()}>Stop</button>
              </div>
            </div>
          </div>
        )}

        {truncation && (
          <div className="ag-banner ag-note">
            <div>
              <b>The diff was too large to send in full.</b>{" "}
              {truncation.omitted.length} file{truncation.omitted.length === 1 ? "" : "s"} were
              omitted, so the answer may be partial.
            </div>
          </div>
        )}

        {failure && <FailureRow failure={failure} name={name} />}
      </div>

      <div className="ag-composer">
        <textarea
          value={question}
          disabled={streaming}
          placeholder={`Ask ${name} about this pull request…`}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter newlines — a question is usually one line.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(question); }
          }}
        />
        <div className="ag-cfoot">
          <span className="ag-priv">Private to you</span>
          <button className="ag-send" disabled={streaming || !question.trim()} onClick={() => ask(question)}>
            {streaming ? "Asking…" : "Ask"}
          </button>
        </div>
      </div>

      {posting && (
        <PostSheet
          turn={posting}
          prId={pr.id}
          project={project}
          repoId={repoId}
          onClose={() => setPosting(null)}
        />
      )}
    </>
  );
}

/** One exchange. */
function Turn({ turn, onCite, onPost }: {
  turn: AgentTurn;
  onCite: (path: string, line: number) => void;
  onPost: () => void;
}) {
  return (
    <div className="ag-turn">
      <div className="ag-you"><div className="ag-bubble">{turn.question}</div></div>

      <div className="ag-answer">
        <div className="ag-ahead">
          <span className="ag-who">{(turn.connectorName ?? "Agent").toUpperCase()}</span>
          <ProvenanceBadge turn={turn} />
        </div>

        {turn.errorCode
          ? <p className="ag-failed">This answer failed before it finished — <code>{turn.errorCode}</code>.</p>
          : <Markdown text={turn.answer} />}

        {turn.stopped && <p className="ag-failed">You stopped this answer, so it is incomplete.</p>}

        {/* An inference is boxed as well as badged: the agent cannot know why a human chose
            something, and the UI must not let it sound like it does. */}
        {turn.inferenceNote && (
          <div className="ag-infer"><b>This part is a guess.</b> {turn.inferenceNote}</div>
        )}

        {/* Hidden entirely in mode 3 — an answer with no asserted source has no citations to
            show, and inventing the strip would imply otherwise. */}
        {turn.mode !== "unverified" && turn.citations.length > 0 && (
          <div className="ag-cites">
            {turn.citations.map((c, i) => (
              <button key={i} className="ag-cite" onClick={() => onCite(c.path, c.line)}
                title={`${c.path}:${c.line}`}>
                {fileName(c.path)}:{c.line}
              </button>
            ))}
          </div>
        )}

        <div className="ag-afoot">
          <button className="ag-mini" onClick={() => navigator.clipboard?.writeText(turn.answer)}>
            Copy
          </button>
          {/* Absent rather than disabled when not postable: there is nothing the reviewer could do
              to make a stopped, failed or unverified answer postable (§7.4). */}
          {turn.postable && (
            <button className="ag-mini" onClick={onPost}>Post as comment…</button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * §5.2.1's badge. Always present — there is no unbadged answer — and it only ever renders a value
 * the agent asserted. Never derived from whether citations happen to be present.
 */
function ProvenanceBadge({ turn }: { turn: AgentTurn }) {
  if (turn.mode === "unverified" || !turn.provenance) {
    return (
      <span className="ag-prov unver"
        title="This connector didn't state where the answer came from. Treat it as unverified.">
        UNVERIFIED SOURCE
      </span>
    );
  }

  const map: Record<string, [string, string, string]> = {
    code: ["code", "FROM DIFF", "Grounded in code visible in this pull request."],
    doc: ["doc", "FROM PR DESC", "Grounded in the PR description or a linked work item."],
    inferred: ["infer", "INFERRED", "Not stated anywhere — reasoning from convention. Treat as a hypothesis."],
  };
  const [cls, label, title] = map[turn.provenance] ?? map.inferred;
  return <span className={`ag-prov ${cls}`} title={title}>{label}</span>;
}

/** §4's codes, in the panel. Each says what to do next rather than merely what broke. */
function FailureRow({ failure, name }: { failure: { code: string; detail?: string | null }; name: string }) {
  const copy: Record<string, string> = {
    auth: `${name}'s credential was rejected. Fix it in Settings › Connectors.`,
    expired: `${name}'s credential has expired. Replace it in Settings › Connectors.`,
    dns: `Launchpad's server couldn't resolve ${name}'s host.`,
    refused: `Nothing was listening at ${name}'s address.`,
    tls: `${name}'s certificate wasn't accepted by the Launchpad server.`,
    timeout: `${name} didn't answer in time. Try again.`,
    rate_limited: `${name} is rate-limiting us. Wait a moment and try again.`,
    not_found: `${name}'s endpoint returned 404 — check its base URL in Settings.`,
    unsupported: `${name} can't produce structured answers, so sources aren't stated.`,
    upstream: `${name} returned an error.`,
  };

  return (
    <div className="ag-banner ag-fail">
      <div>
        <b>{copy[failure.code] ?? `${name} returned an error.`}</b>
        {failure.detail && <> {failure.detail}</>}
      </div>
    </div>
  );
}

/**
 * §7.4 — nothing reaches the pull request without a human.
 *
 * The text is editable, it posts under the reviewer's own name, and the attribution line can be
 * deleted. There is no code path that posts an answer without this sheet being shown first.
 */
function PostSheet({ turn, project, repoId, prId, onClose }: {
  turn: AgentTurn;
  project: string;
  repoId: string;
  prId: number;
  onClose: () => void;
}) {
  const anchor = turn.citations[0];
  const [text, setText] = useState(
    `${turn.answer}\n\n— via ${turn.connectorName ?? "an agent"}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post() {
    setBusy(true);
    setError(null);
    try {
      if (anchor) {
        await api.prCreateThread(project, repoId, prId, {
          filePath: anchor.path.startsWith("/") ? anchor.path : `/${anchor.path}`,
          line: anchor.line,
          content: text,
          onLeft: false,
        });
      } else {
        // No citation to anchor to, so it goes as a PR-level comment rather than being refused.
        await api.prCreateThread(project, repoId, prId, {
          filePath: "", line: 0, content: text, onLeft: false,
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The comment could not be posted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div className="title">Post as a comment on !{prId}</div>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="faint" style={{ fontSize: 12, marginTop: 0 }}>
            Posts under <b>your</b> name
            {anchor ? <> on <code>{fileName(anchor.path)}:{anchor.line}</code></> : <> on the pull request</>}.
            Edit it first — this is a draft, not a review.
          </p>
          <textarea
            className="input"
            style={{ minHeight: 160, resize: "vertical", lineHeight: 1.55 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="faint" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            The <b>— via</b> line is appended so the trail is honest about where the text came from.
            Delete it if you'd rather it read as entirely yours.
          </p>
          {error && <div className="error" style={{ fontSize: 12 }}>{error}</div>}
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn small" onClick={onClose}>Cancel</button>
            <button className="btn small primary" disabled={busy || !text.trim()} onClick={post}>
              {busy ? "Posting…" : "Post comment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The restricted markdown subset §5.2 allows: paragraphs, unordered lists, bold and inline code.
 *
 * Hand-rolled rather than a library because the subset is deliberately tiny — headings and tables
 * do not survive a 380px column, so the prompt forbids them and there is nothing else to support.
 * Text is never inserted as HTML.
 */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0);

  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
        if (isList) {
          return (
            <ul key={i} className="ag-ul">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}
            </ul>
          );
        }
        return <p key={i} className="ag-p">{inline(block)}</p>;
      })}
    </>
  );
}

/** Bold and inline code, as React nodes — never dangerouslySetInnerHTML. */
function inline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return <b key={i}>{part.slice(2, -2)}</b>;
    }
    return part;
  });
}

const fileName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export type { AgentCitation };
