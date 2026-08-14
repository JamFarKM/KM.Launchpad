import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { DiffComposer, DiffThread } from "./DiffThread";
import type { PrThread } from "../types";

/**
 * Monaco's diff editor, themed from the app's design tokens.
 *
 * Monaco parses colours into its own objects and generates a stylesheet, so it can't read
 * `var(--…)` — the tokens have to be resolved to concrete values and the theme redefined
 * whenever the palette changes. The theme is also global to every Monaco instance on the
 * page, which is why it's defined here (one owner) rather than by each caller.
 */

// One worker for everything: language services (IntelliSense, validation) are pointless for a
// read-only diff, and tokenisation for syntax colouring runs on the main thread anyway.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };

const THEME = "launchpad";

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Monaco wants bare hex; tokens may be #rgb, #rrggbb or rgba(). */
function hex(name: string, fallback: string): string {
  const v = token(name);
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.slice(1);
  if (/^#[0-9a-f]{3}$/i.test(v)) return v.slice(1).split("").map((c) => c + c).join("");
  const m = v.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (m) return [1, 2, 3].map((i) => Math.round(+m[i]).toString(16).padStart(2, "0")).join("");
  return fallback;
}

function defineTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const ink = hex("--ink-primary", dark ? "ffffff" : "0b0b0b");
  const muted = hex("--ink-muted", "8b8a84");
  const code = hex("--code-bg", dark ? "161615" : "fcfcfb");
  const gutter = hex("--diff-gutter", dark ? "1c1c1b" : "f6f6f3");
  const addStripe = hex("--diff-add-stripe", dark ? "2b9e2b" : "0a8a0a");
  const delStripe = hex("--diff-del-stripe", dark ? "c95e5e" : "c23434");
  const surface = hex("--bg-surface", dark ? "1a1a19" : "ffffff");
  const surface2 = hex("--bg-surface-2", dark ? "212120" : "fbfbf9");
  const border = hex("--border-strong", dark ? "2e2e2c" : "e3e3df");
  const accent = hex("--accent", dark ? "3987e5" : "2a78d6");
  const synKeyword = hex("--syn-keyword", dark ? "6da7ec" : "1c5cab");
  const synType = hex("--syn-type", dark ? "35b3c4" : "0d7b8a");
  const synString = hex("--syn-string", dark ? "e0a86a" : "a35a12");
  const synNumber = hex("--syn-number", dark ? "b3a6f0" : "5d4bb8");
  const synComment = hex("--syn-comment", "8b8a84");
  const synPunct = hex("--syn-punct", dark ? "c3c2b7" : "52514e");

  monaco.editor.defineTheme(THEME, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    /* Syntax palette (REVIEW §3, move 3): no green and no red anywhere. The diff tint owns
       those hues, so code using them is unreadable on a tinted row — a green string on a
       green added line is exactly the failure being fixed. Comments are neutral grey, which
       is the single biggest legibility win on a mostly-commented added block. */
    rules: [
      { token: "", foreground: ink },
      { token: "comment", foreground: synComment, fontStyle: "italic" },
      { token: "string", foreground: synString },
      { token: "string.escape", foreground: synString },
      { token: "regexp", foreground: synString },
      { token: "number", foreground: synNumber },
      { token: "constant", foreground: synNumber },
      { token: "keyword", foreground: synKeyword },
      { token: "keyword.json", foreground: synKeyword },
      { token: "operator", foreground: synPunct },
      { token: "delimiter", foreground: synPunct },
      { token: "type", foreground: synType },
      { token: "type.identifier", foreground: synType },
      { token: "annotation", foreground: synType },
      { token: "tag", foreground: synKeyword },
      { token: "attribute.name", foreground: synType },
      { token: "attribute.value", foreground: synString },
      { token: "variable", foreground: ink },
      { token: "identifier", foreground: ink },
    ],
    colors: {
      // surfaces — the editor sits on the same code surface as the JSON pane
      "editor.background": `#${code}`,
      "editor.foreground": `#${ink}`,
      // Move 2: the gutter never tints, so line numbers stop competing with a coloured
      // background. The insert/delete overlays inside the margin are neutralised in CSS.
      "editorGutter.background": `#${gutter}`,
      "editorWidget.background": `#${surface}`,
      "editorWidget.border": `#${border}`,
      "editorWidget.foreground": `#${ink}`,
      "focusBorder": `#${accent}`,

      // gutter + guides
      "editorLineNumber.foreground": `#${muted}99`,
      "editorLineNumber.activeForeground": `#${ink}`,
      "editorIndentGuide.background1": `#${muted}22`,
      "editorIndentGuide.activeBackground1": `#${muted}44`,
      "editorWhitespace.foreground": `#${muted}55`,
      "editor.lineHighlightBackground": "#00000000",
      "editor.lineHighlightBorder": "#00000000",

      // selection follows the app's accent-as-selection rule (A1)
      "editor.selectionBackground": `#${accent}3d`,
      "editor.inactiveSelectionBackground": `#${accent}1f`,
      "editor.selectionHighlightBackground": `#${accent}26`,

      // scrollbars — muted, not the OS default slab
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": `#${muted}33`,
      "scrollbarSlider.hoverBackground": `#${muted}55`,
      "scrollbarSlider.activeBackground": `#${muted}77`,

      /* Diff row/word painting is done in CSS, not here (see .review-diff rules in
         styles.css). The tokens are color-mix()/oklab values and Monaco's colour parser
         only understands hex and rgba, so resolving them through defineTheme is not
         possible — CSS is the only way to drive the diff from --diff-* directly.
         These are transparent so the theme doesn't paint a second layer underneath. */
      "diffEditor.insertedTextBackground": "#00000000",
      "diffEditor.removedTextBackground": "#00000000",
      "diffEditor.insertedLineBackground": "#00000000",
      "diffEditor.removedLineBackground": "#00000000",
      "diffEditorGutter.insertedLineBackground": "#00000000",
      "diffEditorGutter.removedLineBackground": "#00000000",

      "diffEditor.border": `#${border}`,
      // The empty side of a side-by-side pair — a non-content plane, which is the case A5
      // allows texture on. Monaco draws it as diagonal fill rather than a tinted row.
      "diffEditor.diagonalFill": `#${muted}2b`,
      "diffEditorOverview.insertedForeground": `#${addStripe}8c`,
      "diffEditorOverview.removedForeground": `#${delStripe}8c`,
      "editorOverviewRuler.border": "#00000000",

      // collapsed "unchanged region" strips — recessed, like the app's inset surfaces
      "diffEditor.unchangedRegionBackground": `#${surface2}`,
      "diffEditor.unchangedRegionForeground": `#${muted}`,
      "diffEditor.unchangedCodeBackground": `#${muted}0f`,
    },
  });
  monaco.editor.setTheme(THEME);
}

/** Best-effort language id from a file path, for syntax colouring. */
function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    cs: "csharp", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", yml: "yaml", yaml: "yaml", xml: "xml", html: "html", css: "css",
    scss: "scss", sql: "sql", sh: "shell", ps1: "powershell", py: "python", go: "go",
    java: "java", rb: "ruby", php: "php", md: "markdown", tf: "hcl", dockerfile: "dockerfile",
    csproj: "xml", props: "xml", targets: "xml", config: "xml",
  };
  return map[ext] ?? "plaintext";
}

export interface DiffStats {
  added: number;
  removed: number;
}

interface Anchor { top: number; left: number; }

/**
 * Where an overlay anchored to one line should sit, kept in step with scrolling and relayout.
 *
 * Both overlays on this editor — the PR comment composer and an annotation card — are overlays rather
 * than view zones (DESIGN_SPEC_REVIEW.md §6, confirmed): inserting a row into a long diff reflows
 * everything below it and reads as the page jumping. Keeping one pinned takes three subscriptions and
 * an off-screen check, so it is written once here rather than twice at the call sites.
 *
 * Returns null when the line is scrolled out of view — dropping the overlay rather than pinning it to
 * an edge, where it would point confidently at a line that isn't there.
 */
function useLineAnchor(
  line: number | null,
  editorRef: React.RefObject<monaco.editor.IStandaloneDiffEditor | null>,
  hostRef: React.RefObject<HTMLDivElement | null>,
  relayout: string,
): Anchor | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || line == null) { setAnchor(null); return; }
    const right = editor.getModifiedEditor();

    const sync = () => {
      const height = right.getLayoutInfo().height;
      const top = right.getTopForLineNumber(line) - right.getScrollTop() + right.getOption(
        monaco.editor.EditorOption.lineHeight,
      );
      if (top < 0 || top > height - 40) { setAnchor(null); return; }

      /* Both anchor to the modified side, so the card has to sit over that pane. Side by side, a fixed
         left offset put it over the original pane instead — pointing at a line in the pane it wasn't
         covering. Inline, the modified editor fills the host and this resolves to zero. */
      const hostBox = hostRef.current?.getBoundingClientRect();
      const paneBox = right.getContainerDomNode().getBoundingClientRect();
      setAnchor({ top, left: hostBox ? Math.max(0, paneBox.left - hostBox.left) : 0 });
    };

    sync();
    const subs = [right.onDidScrollChange(sync), right.onDidLayoutChange(sync), right.onDidContentSizeChange(sync)];
    return () => subs.forEach((s) => s.dispose());
  }, [line, relayout, editorRef, hostRef]);

  return anchor;
}

interface Props {
  path: string;
  before: string;
  after: string;
  /** Inline (unified) rather than side-by-side. */
  inline?: boolean;
  /** Content on screen is for a previous file while a new one loads — dim it. */
  stale?: boolean;
  /** Wrap long lines rather than clipping them (§5). */
  wrap?: boolean;
  /** Code font size in px, from --code-size (§5). */
  fontSize?: number;
  /** Line counts, reported once Monaco has computed the diff. */
  onStats?: (stats: DiffStats) => void;
  /**
   * A line to scroll to and mark, from an agent citation (DESIGN_SPEC_CONNECTORS.md §5.2.1).
   *
   * Declarative with a nonce rather than an imperative ref: clicking the same chip twice has to
   * work, and a changing nonce is what makes a repeat click a new instruction rather than a no-op.
   */
  cite?: { line: number; nonce: number } | null;
  /** Threads anchored to this file. Rendered inline as view zones. */
  threads?: PrThread[];
  onReply?: (threadId: number, content: string) => Promise<void>;
  onSetStatus?: (threadId: number, status: string) => Promise<void>;
  onNewThread?: (line: number, content: string) => Promise<void>;

  /**
   * Lines in this file the agent has cited (DESIGN_SPEC_CONNECTORS.md §7.6). Each gets a persistent
   * gutter marker — cheap, and needing no extra request, because the citation data already exists.
   */
  annotations?: { line: number; resolved: boolean; hasReplies: boolean; severity: string }[];

  /** Clicking an annotation marker. Distinct from clicking the gutter to start a new PR comment. */
  onOpenAnnotation?: (line: number) => void;

  /**
   * A line to anchor an overlay to, and what to draw there.
   *
   * A render prop rather than a child, because the geometry lives here — the scroll, layout and
   * content-size listeners that keep an overlay pinned to a line are already in this component, and
   * duplicating them in the page would be a second thing to get wrong every time Monaco relaid out.
   */
  anchorLine?: number | null;
  renderAnchored?: (geometry: { top: number; left: number }) => React.ReactNode;
}

export function MonacoDiff({
  path, before, after, inline, stale, wrap, fontSize, onStats,
  cite, threads, onReply, onSetStatus, onNewThread,
  annotations, onOpenAnnotation, anchorLine, renderAnchored,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  // Held in a ref so the editor is created once and never torn down just to swap the callback.
  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  /** Set when models change; cleared by the first diff update, which triggers the fade in. */
  const pendingReveal = useRef(true);
  /** Line the "new comment" composer is open on, if any. */
  const [composerLine, setComposerLine] = useState<number | null>(null);
  /** Line under the pointer, so the gutter can offer a "+" to comment on it. */
  const [hoverLine, setHoverLine] = useState<number | null>(null);

  // Create once; the models and options are updated in place afterwards.
  useEffect(() => {
    if (!hostRef.current) return;
    defineTheme();
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      theme: THEME,
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: !inline,
      renderOverviewRuler: true,
      // The +/- sign column: the colour-independent fallback that keeps additions and
      // deletions distinguishable in greyscale (§11). Present in both view modes.
      renderIndicators: true,
      ignoreTrimWhitespace: false,
      // 25 lines per step, matching the spec's expand-up/expand-down increments (§5).
      hideUnchangedRegions: { enabled: true, revealLineCount: 25 },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineHeight: 19,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      minimap: { enabled: false },
      renderWhitespace: "selection",
      guides: { indentation: false },
      glyphMargin: true, // carries the "comment here" affordance and thread markers
      padding: { top: 10, bottom: 10 },
      lineNumbersMinChars: 4,
      lineDecorationsWidth: 8,
      overviewRulerLanes: 2,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      diffAlgorithm: "advanced", // word-level within changed lines
    });
    editorRef.current = editor;

    const statsSub = editor.onDidUpdateDiff(() => {
      // Line counts come from Monaco's own diff rather than a second algorithm on our side.
      const changes = editor.getLineChanges() ?? [];
      let added = 0;
      let removed = 0;
      for (const c of changes) {
        if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
        if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
      }
      statsRef.current?.({ added, removed });

      // Reveal only once the diff is computed. Showing the models the moment they're set
      // means a frame of undiffed text, then decorations and the collapsed regions landing
      // on top — which is the jitter. Waiting one update and fading in hides all of it.
      if (pendingReveal.current) {
        pendingReveal.current = false;
        requestAnimationFrame(() => hostRef.current?.classList.remove("is-swapping"));
      }
    });

    // Re-theme when the app's palette flips (settings dispatches this).
    const onSettings = () => defineTheme();
    window.addEventListener("pl-settings", onSettings);

    return () => {
      window.removeEventListener("pl-settings", onSettings);
      statsSub.dispose();
      editor.dispose();
      modelsRef.current?.original.dispose();
      modelsRef.current?.modified.dispose();
      modelsRef.current = null;
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({
      renderSideBySide: !inline,
      wordWrap: wrap ? "on" : "off",
      fontSize: fontSize ?? 12,
      lineHeight: Math.round((fontSize ?? 12) * 1.58),
    });
  }, [inline, wrap, fontSize]);

  // Swap models when the selected file changes. Old models must be disposed explicitly —
  // Monaco keeps them alive otherwise and the memory adds up over a review session.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Hide before swapping, and let the diff-update handler fade it back in.
    pendingReveal.current = true;
    hostRef.current?.classList.add("is-swapping");
    const lang = languageOf(path);
    const original = monaco.editor.createModel(before, lang);
    const modified = monaco.editor.createModel(after, lang);
    editor.setModel({ original, modified });
    const previous = modelsRef.current;
    modelsRef.current = { original, modified };
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [path, before, after]);

  /**
   * Reveal and mark a cited line (§5.2.1).
   *
   * <b>This used a raw `deltaDecorations` id set and silently painted nothing.</b> The id-set form
   * does not survive the diff editor's own decoration pass, which re-runs on every `onDidUpdateDiff`
   * — and a citation click is very often followed by exactly that, because it swaps the file and the
   * diff recomputes a frame later. The decoration was applied and then reconciled away, which is why
   * it left no trace and no error: nothing failed, it was simply overwritten.
   *
   * A decorations collection re-applies itself across those passes. The evidence was two effects
   * below the whole time — the thread markers and the hover glyph use a collection and have always
   * worked, in the same editor, in the same component.
   *
   * Violet, deliberately distinct from the diff's add/remove greens and reds, so a citation can
   * never be mistaken for a change. It marks the margin as well as the row, because on an added line
   * the row is already tinted and a wash over a wash is not a signal.
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !cite) return;
    const right = editor.getModifiedEditor();

    const dec = right.createDecorationsCollection([{
      range: new monaco.Range(cite.line, 1, cite.line, 1),
      options: {
        isWholeLine: true,
        className: "agent-cited-line",
        linesDecorationsClassName: "agent-cited-margin",
        overviewRuler: {
          color: "#8a7bea",
          position: monaco.editor.OverviewRulerLane.Right,
        },
      },
    }]);

    // Revealed after the decoration exists, so the line is already marked when it arrives on screen
    // rather than being highlighted a frame after the scroll settles.
    right.revealLineInCenter(cite.line);

    return () => dec.clear();
  }, [cite, path, before, after]);

  // ---- comment threads, rendered inline as view zones on the modified (right) side ----

  // Offer "comment on this line" from the glyph margin, with a "+" that follows the pointer
  // down the gutter so the affordance is visible rather than something you have to know about.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !onNewThread) return;
    const right = editor.getModifiedEditor();

    const down = right.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      if (!line) return;

      /* An annotated line's marker opens its annotation; any other line starts a new PR comment.
         Two different actions sharing one gutter, which is why the marker's own hover message says
         which one you are about to get. */
      if (onOpenAnnotation && annotationLines.current.has(line)) {
        onOpenAnnotation(line);
        return;
      }

      setComposerLine((cur) => (cur === line ? null : line));
    });

    const GUTTER = new Set<number>([
      monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
      monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
      monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
      monaco.editor.MouseTargetType.CONTENT_TEXT,
      monaco.editor.MouseTargetType.CONTENT_EMPTY,
    ]);
    const move = right.onMouseMove((e) => {
      const line = GUTTER.has(e.target.type) ? e.target.position?.lineNumber ?? null : null;
      setHoverLine((cur) => (cur === line ? cur : line));
    });
    const leave = right.onMouseLeave(() => setHoverLine(null));

    return () => { down.dispose(); move.dispose(); leave.dispose(); };
  }, [onNewThread, onOpenAnnotation]);

  /* Which lines carry an annotation, in a ref rather than in the handler's closure. The mouse-down
     subscription is deliberately not re-created when the annotation list changes — re-subscribing on
     every refetch would drop a click that landed mid-flight. */
  const annotationLines = useRef<Set<number>>(new Set());
  annotationLines.current = new Set((annotations ?? []).map((a) => a.line));

  /**
   * The persistent gutter markers (§7.6).
   *
   * Violet, matching the citation chips and the cited-line highlight, so a marker reads as "the agent
   * said something here" rather than as a diff change or a human comment. Resolved ones dim instead of
   * disappearing — the record survives, and `Show resolved` brings them back into the cycle.
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const right = editor.getModifiedEditor();

    const dec = right.createDecorationsCollection(
      (annotations ?? []).map((a) => ({
        range: new monaco.Range(a.line, 1, a.line, 1),
        options: {
          glyphMarginClassName: `diff-glyph-annotation sev-${a.severity}`
            + (a.resolved ? " is-resolved" : "")
            + (a.hasReplies ? " has-replies" : ""),
          glyphMarginHoverMessage: {
            value: a.severity === "error"
              ? "The agent thinks something here is wrong — click to open"
              : a.severity === "warning"
                ? "The agent flagged this line to check — click to open"
                : a.hasReplies
                  ? "Open this annotation — you've asked about this line"
                  : "Open this annotation — the agent cited this line",
          },
        },
      })),
    );

    return () => dec.clear();
  }, [annotations, path, before, after]);

  // Kept in its own collection so hovering doesn't churn the thread markers or view zones.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !onNewThread) return;
    const right = editor.getModifiedEditor();
    const hasThread = new Set((threads ?? []).map((t) => t.rightLine));
    const show = hoverLine && !hasThread.has(hoverLine) && hoverLine !== composerLine;
    const dec = right.createDecorationsCollection(
      show
        ? [{
            range: new monaco.Range(hoverLine, 1, hoverLine, 1),
            options: {
              glyphMarginClassName: "diff-glyph-add",
              glyphMarginHoverMessage: { value: "Comment on this line" },
            },
          }]
        : [],
    );
    return () => dec.clear();
  }, [hoverLine, threads, composerLine, onNewThread]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const right = editor.getModifiedEditor();
    const list = (threads ?? []).filter((t) => (t.rightLine ?? 0) > 0);

    // Mark commented lines in the glyph margin.
    const decorations = right.createDecorationsCollection(
      list.map((t) => ({
        range: new monaco.Range(t.rightLine!, 1, t.rightLine!, 1),
        options: { glyphMarginClassName: "diff-glyph-comment", glyphMarginHoverMessage: { value: "Comment thread" } },
      })),
    );

    // One React root per zone. Monaco needs a pixel height up front, so the node is measured
    // after React paints and the zone re-laid out in place — mutating the descriptor and
    // calling layoutZone, rather than removing and re-adding, which would churn the zone id.
    const mounted: { id: string; root: Root; ro: ResizeObserver }[] = [];

    const addZone = (afterLineNumber: number, render: (node: HTMLElement) => Root) => {
      const node = document.createElement("div");
      node.className = "diff-zone";
      const zone: monaco.editor.IViewZone = {
        afterLineNumber,
        domNode: node,
        heightInPx: 0,
        suppressMouseDown: true, // let the thread's own inputs take the click
      };
      let zoneId = "";
      right.changeViewZones((a) => { zoneId = a.addZone(zone); });

      const root = render(node);
      const sync = () => {
        const h = node.scrollHeight;
        if (h > 0 && h !== zone.heightInPx) {
          zone.heightInPx = h;
          right.changeViewZones((a) => a.layoutZone(zoneId));
        }
      };
      // Re-measure as the thread grows (typing a reply, a long comment wrapping).
      const ro = new ResizeObserver(sync);
      ro.observe(node);
      requestAnimationFrame(sync);

      mounted.push({ id: zoneId, root, ro });
    };

    for (const t of list) {
      addZone(t.rightLine!, (node) => {
        const root = createRoot(node);
        root.render(
          <DiffThread
            thread={t}
            onReply={async (id, content) => { await onReply?.(id, content); }}
            onSetStatus={async (id, status) => { await onSetStatus?.(id, status); }}
          />,
        );
        return root;
      });
    }

    return () => {
      decorations.clear();
      right.changeViewZones((a) => mounted.forEach((m) => a.removeZone(m.id)));
      mounted.forEach((m) => {
        m.ro.disconnect();
        // Deferred: unmounting a root synchronously from inside an effect cleanup warns.
        setTimeout(() => m.root.unmount(), 0);
      });
    };
  }, [threads, path, onReply, onSetStatus, onNewThread]);

  /* Both overlays — the comment composer and an annotation card — are overlays rather than view
     zones (§6, confirmed): inserting a row into a long diff reflows everything below it and reads as
     the page jumping. The geometry is computed here for the same reason: keeping an overlay pinned to
     a line through scrolling, relayout and the collapsed unchanged regions takes three subscriptions,
     and a second copy in the page would be a second thing to get wrong. */
  // `relayout` is every input that can move a line under the cursor. Bundled into one value so the
  // hook has a stable dependency list rather than one that grows every time a prop is added.
  const relayout = `${path}|${inline}|${wrap}|${fontSize}|${threads?.length}|${annotations?.length}`;
  const composerAnchor = useLineAnchor(composerLine, editorRef, hostRef, relayout);
  const cardAnchor = useLineAnchor(anchorLine ?? null, editorRef, hostRef, relayout);

  // Close on file or view change — the anchor line means something different afterwards.
  useEffect(() => { setComposerLine(null); }, [path, inline]);

  const composerOpen = composerLine != null && composerAnchor != null && !!onNewThread;

  return (
    <div className="monaco-shell">
      <div className={`monaco-host is-swapping ${stale ? "is-stale" : ""}`} ref={hostRef} />
      {composerOpen && (
        <>
          {/* Dims the lines the card covers, so they read as deliberately obscured rather
              than as a rendering fault. */}
          <div className="diff-scrim" style={{ top: composerAnchor.top - 4 }} />
          <DiffComposer
            line={composerLine}
            top={composerAnchor.top}
            left={composerAnchor.left}
            onCancel={() => setComposerLine(null)}
            onSubmit={async (content) => { await onNewThread!(composerLine, content); setComposerLine(null); }}
          />
        </>
      )}
      {anchorLine != null && cardAnchor != null && renderAnchored?.(cardAnchor)}
    </div>
  );
}
