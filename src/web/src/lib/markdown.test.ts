import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./markdown";

describe("parseBlocks", () => {
  it("reads a typical PR template", () => {
    const blocks = parseBlocks([
      "## Summary",
      "Moves the bonus check",
      "behind the flag.",
      "",
      "## Testing",
      "- [x] unit tests",
      "- [ ] staging",
      "  still pending",
      "",
      "---",
      "| Env | Result |",
      "|-----|:------:|",
      "| dev | ok |",
    ].join("\n"));

    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Summary" },
      { kind: "paragraph", lines: ["Moves the bonus check", "behind the flag."] },
      { kind: "heading", level: 2, text: "Testing" },
      {
        kind: "list", ordered: false, items: [
          { depth: 0, checked: true, text: "unit tests" },
          { depth: 0, checked: false, text: "staging still pending" },
        ],
      },
      { kind: "rule" },
      { kind: "table", header: ["Env", "Result"], rows: [["dev", "ok"]] },
    ]);
  });

  it("keeps fenced code verbatim, markup and all", () => {
    expect(parseBlocks("```sql\nSELECT * -- **not bold**\n```")).toEqual([
      { kind: "code", lang: "sql", text: "SELECT * -- **not bold**" },
    ]);
  });

  it("runs an unclosed fence to the end rather than dropping it", () => {
    expect(parseBlocks("```\na\nb")).toEqual([{ kind: "code", lang: "", text: "a\nb" }]);
  });

  it("records nesting depth on ordered lists", () => {
    expect(parseBlocks("1. one\n   2) inner\n2. two")).toEqual([
      {
        kind: "list", ordered: true, items: [
          { depth: 0, checked: null, text: "one" },
          { depth: 1, checked: null, text: "inner" },
          { depth: 0, checked: null, text: "two" },
        ],
      },
    ]);
  });

  it("normalises CRLF, which ADO stores", () => {
    expect(parseBlocks("# Title\r\n\r\nbody")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", lines: ["body"] },
    ]);
  });
});

describe("parseInline", () => {
  it("splits code, bold, italic and links", () => {
    expect(parseInline("Use `x_y` for **all** *new* [docs](https://example.com/a)")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: "x_y" },
      { kind: "text", text: " for " },
      { kind: "bold", text: "all" },
      { kind: "text", text: " " },
      { kind: "italic", text: "new" },
      { kind: "text", text: " " },
      { kind: "link", text: "docs", href: "https://example.com/a" },
    ]);
  });

  it("never links a non-http target", () => {
    const nodes = parseInline("[click](javascript:alert(1))");
    expect(nodes.some((n) => n.kind === "link")).toBe(false);
    // The words survive; only the target is dropped.
    expect(nodes.map((n) => n.text).join("")).toContain("click");
  });

  it("leaves snake_case identifiers alone", () => {
    expect(parseInline("set max_bonus_amount")).toEqual([{ kind: "text", text: "set max_bonus_amount" }]);
  });

  it("turns an image into a link to it", () => {
    expect(parseInline("![shot](https://dev.azure.com/a.png)")).toEqual([
      { kind: "link", text: "shot", href: "https://dev.azure.com/a.png" },
    ]);
  });
});
