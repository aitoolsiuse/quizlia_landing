// Canonical format contract appended to every prompt that produces
// user-facing free text or JSON with prose strings. Keep in sync with
// docs/superpowers/specs/2026-10-14-ai-text-format-design.md.
export const FREE_TEXT_FORMAT_CONTRACT = `FORMAT:
- Use only these formatting constructs: **bold** for key terms, *italic* for emphasis, "- " for bullet lists, "1. " for numbered lists, and blank lines between paragraphs.
- Never use headings (#), tables, code blocks, links, images, or any other markdown syntax.`;

export const JSON_FORMAT_CONTRACT = `FORMAT:
- The JSON itself must stay plain: no markdown fences, no text outside the JSON.
- Inside explanatory prose values (section content, quick_summary, quiz explanations) use only: **bold**, *italic*, "- " bullet lists, "1. " numbered lists, blank lines between paragraphs.
- Keep titles, captions, key findings and important-notes items, flashcard questions/answers, and quiz questions/options plain — no emphasis or list markers.
- Never use headings (#), tables, code blocks, links, images, or any other markdown syntax.`;
