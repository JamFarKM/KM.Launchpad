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
  /** Threads anchored to this file. Rendered inline as view zones. */
  threads?: PrThread[];
  onReply?: (threadId: number, content: string) => Promise<void>;
  onSetStatus?: (threadId: number, status: string) => Promise<void>;
  onNewThread?: (line: number, content: string) => Promise<void>;
}

export function MonacoDiff({
  path, before, after, inline, stale, wrap, fontSize, onStats,
  threads, onReply, onSetStatus, onNewThread,
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
      hideUnchangedRegions: { enabled: true },
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
      if (line) setComposerLine((cur) => (cur === line ? null : line));
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
  }, [onNewThread]);

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

    if (composerLine && onNewThread) {
      addZone(composerLine, (node) => {
        const root = createRoot(node);
        root.render(
          <DiffComposer
            line={composerLine}
            onCancel={() => setComposerLine(null)}
            onSubmit={async (content) => { await onNewThread(composerLine, content); setComposerLine(null); }}
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
  }, [threads, composerLine, path, onReply, onSetStatus, onNewThread]);

  return <div className={`monaco-host is-swapping ${stale ? "is-stale" : ""}`} ref={hostRef} />;
}
