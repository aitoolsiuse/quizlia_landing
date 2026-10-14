// Parser for the Quizlia text subset (see lib/format-contract.ts):
// **bold**, *italic*, "- " bullets, "1. " numbered lists, blank-line
// paragraphs. Deliberately total and forgiving — plain text and unknown
// syntax pass through as literal content; it never throws.

export interface MarkdownInline {
  text: string;
  strong?: boolean;
  em?: boolean;
}

export type MarkdownBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] };

const BULLET_RE = /^[-*]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const text = (input ?? "").replace(/\r\n?/g, "\n");
  const blocks: MarkdownBlock[] = [];

  for (const chunk of text.split(/\n[ \t]*\n+/)) {
    const lines = chunk
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l, i, arr) => l !== "" || (i > 0 && i < arr.length - 1));
    if (lines.length === 0) continue;

    let i = 0;
    while (i < lines.length) {
      if (BULLET_RE.test(lines[i])) {
        const items: string[] = [];
        while (i < lines.length && BULLET_RE.test(lines[i])) {
          items.push(lines[i].replace(BULLET_RE, ""));
          i++;
        }
        blocks.push({ kind: "ul", items });
      } else if (ORDERED_RE.test(lines[i])) {
        const items: string[] = [];
        while (i < lines.length && ORDERED_RE.test(lines[i])) {
          items.push(lines[i].replace(ORDERED_RE, ""));
          i++;
        }
        blocks.push({ kind: "ol", items });
      } else {
        const paragraphLines: string[] = [];
        while (i < lines.length && !BULLET_RE.test(lines[i]) && !ORDERED_RE.test(lines[i])) {
          paragraphLines.push(lines[i]);
          i++;
        }
        blocks.push({ kind: "paragraph", lines: paragraphLines });
      }
    }
  }
  return blocks;
}

const INLINE_RE = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;

export function parseMarkdownInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], strong: true });
    else out.push({ text: m[2], em: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length > 0 ? out : [{ text: "" }];
}
