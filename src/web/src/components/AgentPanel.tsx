import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { askAgent } from "../lib/askAgent";
import type {
  AgentCitation, AgentSegment, AgentTurn, Connector, ConnectorProvider, PullRequest,
} from "../types";

const PR_QUESTIONS = "pr.questions";

/*
 * These are answerable now. "Is anything here not covered by tests?" shipped in the previous step
 * and was not: without repository access the agent could only guess at it, and a guess about test
 * coverage is exactly the kind a reviewer would act on. It is back because the agent can look.
 */
const SUGGESTIONS = [
  "What does this PR change?",
  "What breaks if I approve this?",
  "Is this change covered by tests?",
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
 * The agent panel — the Review page's left column, second tab (DESIGN_SPEC_CONNECTORS.md §7).
 *
 * <b>Nothing here names a provider or an agent.</b> The header, the composer placeholder and the
 * outage copy all read the assigned connector's own `name` — which is why a connector called
 * "BetBot" that happens to be Anthropic underneath reads as BetBot throughout, and why swapping the
 * provider changes only text.
 */
export function AgentPanel({
  project, repoId, pr, onCite, prefill, onPrefillConsumed,
}: Props) {
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
  /* Claims that have closed during this answer. Each renders as a finished card the moment it
     arrives — the reviewer reads one thought at a time rather than watching a paragraph type
     itself under a badge that can't be decided until the end. */
  const [streamedSegments, setStreamedSegments] = useState<AgentSegment[]>([]);
  /* Mode-3 prose, which is a different thing and looks like one: no badge is earned by it. */
  const [streamed, setStreamed] = useState("");
  const [failure, setFailure] = useState<{ code: string; detail?: string | null } | null>(null);
  const [truncation, setTruncation] = useState<{ omitted: string[] } | null>(null);
  /* What the agent is reading right now, and what it read. Shown so an answer's basis is visible
     rather than implied — a review that claims nothing is untested should show that it looked. */
  const [reading, setReading] = useState<string | null>(null);
  const [reads, setReads] = useState<string[]>([]);
  /* What is being drafted for the pull request: one specific claim, not a whole turn (§7.4). */
  const [posting, setPosting] = useState<{ segment: AgentSegment; connectorName?: string | null } | null>(null);

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
  }, [turns.length, streamedSegments.length, streamed]);

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
    setStreamedSegments([]);
    setStreamed("");
    setFailure(null);
    setTruncation(null);
    setReading(null);
    setReads([]);
    setStreaming(true);

    const controller = new AbortController();
    abort.current = controller;

    try {
      await askAgent(project, repoId, pr.id, q, {
        onContext: (info) => { if (info.truncated) setTruncation({ omitted: info.omitted }); },
        onReading: (info) => {
          setReading(info.detail || info.tool);
          setReads((r) => (info.detail && !r.includes(info.detail) ? [...r, info.detail] : r));
        },
        onSegment: (segment) => setStreamedSegments((s) => [...s, segment]),
        onDelta: (text) => setStreamed((s) => s + text),
        onComplete: (turn) => {
          // The recorded turn replaces what streamed: same segments, but now with an id, a commit
          // and a postability verdict the server decided.
          setTurns((t) => [...t, turn]);
          setStreamedSegments([]);
          setStreamed("");
        },
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

  const name = connector?.name ?? "Agent";
  const unreachable = connector?.status === "unreachable";
  const missing = !connectorsQ.isLoading && !connector;

  /* The panel's header: who is answering, on what model, and whether it is reachable. The status is
     a dot plus a word, and the shape differs per state (A4), so hue is never the only signal. */
  const strip = (
    <div className="ag-head">
      <span className={`ag-dot ${missing ? "none" : unreachable ? "down" : "ok"}`} aria-hidden="true" />
      <div className="ag-id">
        <div className="ag-name">
          {missing ? "No agent connected" : name}
          {/* Provider identity is text and never colour — violet stays reserved for "this is the
              connector answering right now" (§7.1). */}
          {provider && <span className="ag-ptag">{provider.key.replace("_", " ").toUpperCase()}</span>}
        </div>
        <div className="ag-meta">
          {missing ? "Settings › Connectors" : unreachable ? "Unreachable on the last attempt" : connector?.model ?? ""}
        </div>
      </div>
    </div>
  );

  // §7.2 — the one state where a full-panel takeover is right: nothing to preserve, and exactly
  // one useful action.
  if (missing) {
    return (
      <>
        {strip}
        <div className="ag-noconn">
          <b>No agent connected</b>
          <p>
            Connect an agent and this panel will explain the pull request and answer questions
            about it.
          </p>
          <p className="ag-fine">Settings › Connectors. Takes a credential, and a URL for your own endpoint.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {strip}

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
          <Turn
            key={t.id}
            turn={t}
            onCite={onCite}
            onPost={(segment) => setPosting({ segment, connectorName: t.connectorName })}
          />
        ))}

        {streaming && (
          <div className="ag-turn">
            <div className="ag-you">{/* the question is already in the thread once complete */}</div>
            <div className="ag-answer">
              <div className="ag-ahead">
                <span className="ag-who">{name.toUpperCase()}</span>
              </div>

              {/* Claims that have already closed. Badged and citable immediately — they are finished
                  statements, and holding them back until the whole turn lands would be pretending
                  the agent hadn't said them yet. */}
              {streamedSegments.map((s, i) => (
                <Segment key={i} segment={s} onCite={onCite} />
              ))}

              {/* Mode 3: prose from a connector that asserts nothing. One badge, and it says so. */}
              {streamed && (
                <div className="ag-seg">
                  <Markdown text={streamed} />
                  <div className="ag-segfoot">
                    <ProvenanceBadge provenance={null} />
                  </div>
                </div>
              )}

              {/* The claim still being written. A placeholder rather than the whole turn sitting at
                  CHECKING SOURCES, which used to make finished claims wait on unfinished ones. */}
              <div className="ag-pending">
                <span className="ag-prov pending" title="The source is stated when this part lands.">
                  CHECKING SOURCES
                </span>
                {/* Naming the file it is reading turns a long pause into visible progress, and is the
                    difference between "this is slow" and "this is checking something". */}
                {reading
                  ? <span className="ag-thinking">reading <code>{reading}</code>…</span>
                  : streamedSegments.length === 0 && !streamed
                    ? <span className="ag-thinking">reading the diff and the description…</span>
                    : null}
              </div>

              {reads.length > 0 && (
                <div className="ag-reads">
                  looked at {reads.length} file{reads.length === 1 ? "" : "s"} beyond the diff
                </div>
              )}
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
          segment={posting.segment}
          connectorName={posting.connectorName}
          prId={pr.id}
          project={project}
          repoId={repoId}
          onClose={() => setPosting(null)}
        />
      )}
    </>
  );
}

/**
 * One exchange: a question, then one card per claim.
 *
 * <b>There is no code path here that treats the answer as one string.</b> `turn.answer` exists and is
 * used exactly once, by "Copy all" — rendering from it would put every badge and every citation back
 * under a whole turn, which is the defect the segment shape exists to remove.
 */
function Turn({ turn, onCite, onPost }: {
  turn: AgentTurn;
  onCite: (path: string, line: number) => void;
  onPost: (segment: AgentSegment) => void;
}) {
  return (
    <div className="ag-turn">
      <div className="ag-you"><div className="ag-bubble">{turn.question}</div></div>

      <div className="ag-answer">
        <div className="ag-ahead">
          <span className="ag-who">{(turn.connectorName ?? "Agent").toUpperCase()}</span>
        </div>

        {turn.errorCode && (
          <p className="ag-failed">
            {failureCopy(turn.errorCode, turn.connectorName ?? "The agent")}
            {turn.errorDetail && <> {turn.errorDetail}</>}
          </p>
        )}

        {turn.segments.map((s, i) => (
          <Segment
            key={i}
            segment={s}
            onCite={onCite}
            // Absent rather than disabled when not postable: there is nothing the reviewer could do
            // to make a stopped, failed or unverified claim postable (§7.4).
            onPost={turn.postable ? () => onPost(s) : undefined}
          />
        ))}

        {turn.stopped && <p className="ag-failed">You stopped this answer, so it is incomplete.</p>}

        <div className="ag-afoot">
          <button className="ag-mini" onClick={() => navigator.clipboard?.writeText(turn.answer)}
            title="Copy every part of this answer as one block of text">
            Copy all
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One claim: its text, its own badge, its own hedge, its own citations (§5.2).
 *
 * The order is deliberate and matches the mockup: text, then the badge under it, then the citations
 * under that — so a citation is unambiguously *this* claim's rather than the next one's.
 */
export function Segment({ segment, onCite, onPost }: {
  segment: AgentSegment;
  onCite: (path: string, line: number) => void;
  onPost?: () => void;
}) {
  const unverified = !segment.provenance;
  const severity = segment.severity === "warning" || segment.severity === "error"
    ? segment.severity
    : "info";

  /* A badge is *about* text, so with no text there is nothing to badge. The server no longer produces
     empty segments, but this is the second half of that fix: a badge floating over nothing told the
     reviewer the agent had said something unreadable, when in fact it had said nothing. */
  if (segment.text.trim().length === 0) return null;

  return (
    <div className={`ag-seg ${unverified ? "is-unver" : ""}`} data-sev={severity}>
      {/* Only the two that ask for something get a label. Marking every descriptive sentence
          "INFORMATIONAL" is the noise that makes the other two stop registering — info is the
          baseline, and the baseline does not need announcing. */}
      {severity !== "info" && <SeverityFlag severity={severity} />}

      <Markdown text={segment.text} />

      {/* An inference is boxed as well as badged: the agent cannot know why a human chose
          something, and the UI must not let it sound like it does. Under this claim only — a hedge
          on one segment says nothing about the others. */}
      {segment.inferenceNote && (
        <div className="ag-infer"><b>This part is a guess.</b> {segment.inferenceNote}</div>
      )}

      <div className="ag-segfoot">
        <ProvenanceBadge provenance={segment.provenance} />

        {/* Hidden on an unverified claim — the agent asserted no source, so there is nothing to
            point at, and showing a strip would imply otherwise. */}
        {!unverified && segment.citations.map((c, i) => (
          <button key={i} className="ag-cite" onClick={() => onCite(c.path, c.line)}
            title={`${c.path}:${c.line}${c.endLine ? `–${c.endLine}` : ""} — jump to this line`}>
            {fileName(c.path)}:{c.line}
          </button>
        ))}

        {onPost && (
          <button className="ag-mini ag-post" onClick={onPost}
            title="Post this one point as a comment on the pull request">
            Post as comment…
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * How much a claim should worry the reviewer.
 *
 * A word, a hue and a shape, in that order of importance. The hue is the least of the three: it is
 * the only one that fails in greyscale and the only one a reviewer can be blind to, so `Check` and
 * `Problem` are spelled out and the glyphs differ in outline rather than only in colour.
 *
 * `--status-warn` and `--status-bad` are the right tokens here rather than an A2 violation — "this
 * will break" is a genuine health signal, which is exactly what those tokens are reserved for.
 */
function SeverityFlag({ severity }: { severity: "warning" | "error" }) {
  const warning = severity === "warning";
  return (
    <span className={`ag-sev ${severity}`}
      title={warning
        ? "Worth checking before you approve."
        : "The agent thinks this is wrong and should be fixed before merging."}>
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {warning
          // A triangle: the one shape that still reads as "caution" with no colour at all.
          ? <><path d="M8 2.6L14.5 13.4h-13z" /><path d="M8 6.6v3.1M8 11.6v.1" /></>
          // A circle with a cross — a different outline, not the same glyph in another hue.
          : <><circle cx="8" cy="8" r="5.9" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></>}
      </svg>
      {warning ? "Check" : "Problem"}
    </span>
  );
}

/**
 * §5.2.1's badge, per segment. Always present — there is no unbadged claim — and it only ever
 * renders a value the agent asserted. Never derived from whether citations happen to be present.
 */
function ProvenanceBadge({ provenance }: { provenance?: string | null }) {
  if (!provenance) {
    /* Not "INFERRED", though the two look interchangeable from outside.
     *
     * `inferred` is a claim the agent makes about its own grounding — "I'm reasoning from convention"
     * — and it arrives with a hedge explaining what it would take to be sure. This badge is the
     * opposite: the agent asserted *nothing*, because its connector couldn't produce structured
     * output. Painting that as `inferred` would be the client inventing a provenance value, which is
     * the one thing §5.2.1 says never to do — and it would be indistinguishable from a real hedge the
     * agent had actually thought about.
     *
     * So it says what is true and no more: the source wasn't stated. */
    return (
      <span className="ag-prov unver"
        title={"The agent didn't say where this came from — its connector can't return sources. "
             + "That's not the same as a hedge: nothing here was assessed."}>
        SOURCE NOT STATED
      </span>
    );
  }

  const map: Record<string, [string, string, string]> = {
    code: ["code", "FROM DIFF", "Grounded in code visible in this pull request."],
    doc: ["doc", "FROM PR DESC", "Grounded in the PR description or a linked work item."],
    inferred: ["infer", "INFERRED", "Not stated anywhere — reasoning from convention. Treat as a hypothesis."],
  };
  const [cls, label, title] = map[provenance] ?? map.inferred;
  return <span className={`ag-prov ${cls}`} title={title}>{label}</span>;
}

/** §4's codes, in the panel. Each says what to do next rather than merely what broke. */
export function failureCopy(code: string | null | undefined, name: string): string {
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
    /* Deliberately vague, because the code is: `upstream` is the taxonomy's catch-all and covers a
       5xx, a mid-stream error envelope, and an answer that came back empty. The `detail` beside it
       is what actually distinguishes those, which is why it is now stored on the turn rather than
       only streamed — a reload used to reduce all three to this one sentence. */
    upstream: `${name} returned an error.`,
  };

  return copy[code ?? ""] ?? `${name} returned an error.`;
}

/** §4's codes, live. Each says what to do next rather than merely what broke. */
function FailureRow({ failure, name }: { failure: { code: string; detail?: string | null }; name: string }) {
  return (
    <div className="ag-banner ag-fail">
      <div>
        <b>{failureCopy(failure.code, name)}</b>
        {failure.detail && <> {failure.detail}</>}
      </div>
    </div>
  );
}

/**
 * §7.4 — nothing reaches the pull request without a human.
 *
 * The text is editable, it posts under the reviewer's own name, and the attribution line can be
 * deleted. There is no code path that posts anything without this sheet being shown first.
 *
 * It posts <b>one segment</b>, not a whole turn. That is a direct benefit of bundling citations at
 * the claim level: the segment already names a `path` and `line`, so the comment can be anchored
 * there instead of landing as a general PR comment the reviewer has to place by hand.
 */
export function PostSheet({ segment, connectorName, project, repoId, prId, onClose }: {
  segment: AgentSegment;
  connectorName?: string | null;
  project: string;
  repoId: string;
  prId: number;
  onClose: () => void;
}) {
  const anchor = segment.citations[0];
  const [text, setText] = useState(
    `${segment.text}\n\n— via ${connectorName ?? "an agent"}`);
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
export function Markdown({ text }: { text: string }) {
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
