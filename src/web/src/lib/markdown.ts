/**
 * Markdown for a pull request description or comment, parsed to a small tree that React renders.
 *
 * Wider than the agent panel's subset (AgentPanel's `Markdown`), because this is text a person wrote
 * in Azure DevOps's own editor — PR templates lean on headings, task lists and tables, and showing
 * `## Testing` as a literal line is worse than not showing the description at all. Still hand-rolled,
 * for the same reason the agent's is: the input is untrusted, nothing here is ever inserted as HTML,
 * and a link only becomes a link when its target is http(s).
 *
 * Deliberately not CommonMark. Anything this doesn't recognise falls through as paragraph text, which
 * shows the author's characters rather than swallowing them.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "link"; text: string; href: string };

export interface ListItem {
  depth: number;
  /** null for a plain item; true/false for a `[x]` / `[ ]` task. */
  checked: boolean | null;
  text: string;
}

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", lines: para });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      // An unclosed fence runs to the end, which is what every renderer does with one.
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      blocks.push({ kind: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }

    // Checked before lists, so `---` and `* * *` are rules rather than empty list items.
    if (RULE.test(line)) { flush(); blocks.push({ kind: "rule" }); continue; }

    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])![1]);
      i--;
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const header = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const items: ListItem[] = [];
      for (; i < lines.length; i++) {
        const m = ITEM.exec(lines[i]);
        if (m) {
          const task = TASK.exec(m[3]);
          items.push({
            // Two spaces or a tab per level, which is what both ADO's editor and GitHub's emit.
            depth: Math.floor(m[1].replace(/\t/g, "  ").length / 2),
            checked: task ? task[1] !== " " : null,
            text: task ? task[2] : m[3],
          });
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          // An indented continuation line belongs to the item above it.
          items[items.length - 1].text += " " + lines[i].trim();
        } else {
          break;
        }
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    para.push(line.trim());
  }

  flush();
  return blocks;
}

/* Code first, so markup inside backticks stays literal. Images are taken as links: an ADO attachment
   URL needs the reviewer's Azure DevOps session to load, and the link is honest about where it goes. */
const INLINE =
  /(`[^`]+`|!?\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\s](?:[^*]*[^*\s])?\*|<https?:\/\/[^>\s]+>)/g;
const LINK = /^!?\[([^\]]*)\]\(([^)\s]+)/;

const safeHref = (href: string) => /^https?:\/\//i.test(href) ? href : null;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (node: Inline) => {
    const last = out[out.length - 1];
    if (node.kind === "text" && last?.kind === "text") last.text += node.text;
    else if (node.kind !== "text" || node.text) out.push(node);
  };

  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      push({ kind: "code", text: part.slice(1, -1) });
    } else if ((part.startsWith("[") || part.startsWith("![")) && LINK.test(part)) {
      const [, label, href] = LINK.exec(part)!;
      const safe = safeHref(href);
      const shown = label || (part.startsWith("!") ? "image" : href);
      // A link with an unsafe target keeps its words and drops the target, rather than vanishing.
      push(safe ? { kind: "link", text: shown, href: safe } : { kind: "text", text: shown });
    } else if (part.startsWith("<http") && part.endsWith(">")) {
      const href = part.slice(1, -1);
      push({ kind: "link", text: href, href });
    } else if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      push({ kind: "bold", text: part.slice(2, -2) });
    } else if (part.startsWith("~~") && part.endsWith("~~")) {
      push({ kind: "strike", text: part.slice(2, -2) });
    } else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      push({ kind: "italic", text: part.slice(1, -1) });
    } else {
      push({ kind: "text", text: part });
    }
  }
  return out;
}
