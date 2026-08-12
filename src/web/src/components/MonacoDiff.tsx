import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

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
  const good = hex("--status-good", dark ? "1abd1a" : "0ca30c");
  const bad = hex("--status-bad", dark ? "e66767" : "d03b3b");
  const violet = hex("--hue-violet", dark ? "9085e9" : "6b5bd6");
  const aqua = hex("--hue-aqua", dark ? "35b3c4" : "1097a8");
  const orange = hex("--hue-orange", dark ? "e08a4a" : "d9722b");

  monaco.editor.defineTheme(THEME, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground: ink },
      { token: "comment", foreground: muted, fontStyle: "italic" },
      { token: "string", foreground: aqua },
      { token: "number", foreground: orange },
      { token: "keyword", foreground: violet },
      { token: "type", foreground: violet },
      { token: "delimiter", foreground: muted },
    ],
    colors: {
      "editor.background": `#${hex("--code-bg", dark ? "131312" : "fafaf8")}`,
      "editor.foreground": `#${ink}`,
      "editorLineNumber.foreground": `#${muted}`,
      "editorLineNumber.activeForeground": `#${ink}`,
      "editorGutter.background": `#${hex("--code-bg", dark ? "131312" : "fafaf8")}`,
      "editorIndentGuide.background1": `#${muted}22`,
      "editorOverviewRuler.border": "#00000000",
      // Diff colours stay conventional green/added, red/removed. This is a deliberate
      // exception to the "green and red are status only" rule: departing from the universal
      // diff convention would cost more comprehension than the rule buys, and the +/- gutter
      // markers carry the meaning without relying on hue.
      "diffEditor.insertedTextBackground": `#${good}26`,
      "diffEditor.removedTextBackground": `#${bad}26`,
      "diffEditor.insertedLineBackground": `#${good}14`,
      "diffEditor.removedLineBackground": `#${bad}14`,
      "diffEditor.border": `#${hex("--border-strong", dark ? "2e2e2c" : "e3e3df")}`,
      "diffEditorGutter.insertedLineBackground": `#${good}1f`,
      "diffEditorGutter.removedLineBackground": `#${bad}1f`,
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

interface Props {
  path: string;
  before: string;
  after: string;
  /** Inline (unified) rather than side-by-side. */
  inline?: boolean;
}

export function MonacoDiff({ path, before, after, inline }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);

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
      ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineHeight: 19,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      minimap: { enabled: false },
      renderWhitespace: "selection",
      guides: { indentation: false },
    });
    editorRef.current = editor;

    // Re-theme when the app's palette flips (settings dispatches this).
    const onSettings = () => defineTheme();
    window.addEventListener("pl-settings", onSettings);

    return () => {
      window.removeEventListener("pl-settings", onSettings);
      editor.dispose();
      modelsRef.current?.original.dispose();
      modelsRef.current?.modified.dispose();
      modelsRef.current = null;
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: !inline });
  }, [inline]);

  // Swap models when the selected file changes. Old models must be disposed explicitly —
  // Monaco keeps them alive otherwise and the memory adds up over a review session.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const lang = languageOf(path);
    const original = monaco.editor.createModel(before, lang);
    const modified = monaco.editor.createModel(after, lang);
    editor.setModel({ original, modified });
    const previous = modelsRef.current;
    modelsRef.current = { original, modified };
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [path, before, after]);

  return <div className="monaco-host" ref={hostRef} />;
}
