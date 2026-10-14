# AI Text Format Contract + Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize all model-generated free text (chat answers, note content, quiz explanations) on a constrained markdown subset, enforce that contract in prompts server-side, and render it properly on web and iOS.

**Architecture:** A single contract constant lives in the web repo and is appended to every Gemini prompt (web routes + the iOS proxy, which forwards all iOS traffic — so one deploy covers every installed app version). Each platform gets one small hand-rolled subset parser: `lib/markdown.ts` + `components/app/MarkdownText.tsx` on web, `Resource/MarkdownFormatter.swift` on iOS. Plain text is a valid instance of the subset, so existing saved data needs no migration.

**Tech Stack:** Next.js 16 (TypeScript, Tailwind, App Router, `@/` alias), UIKit + Swift (no SwiftUI, no storyboard edits).

**Spec:** `docs/superpowers/specs/2026-10-14-ai-text-format-design.md`

## Global Constraints

- Web repo root: `e:\Projects\Arasheed\QuickNote\quizlia_landing`. iOS repo root: `e:\Projects\Arasheed\QuickNote\QuickNote`.
- **No test framework exists and none may be added.** Web verification = `npx tsc --noEmit` + `npx eslint <changed files>` + final `npm run build`. UI is verified by hand by Kevin — never drive a visible browser.
- Never count the 6 pre-existing eslint errors (pricing / profile-selection / settings / subscription-success / PaywallModal files) as new failures.
- **Zero new npm/pod dependencies.**
- Web `main` auto-deploys to Netlify on push — **commit but never push**; Kevin pushes when ready.
- No Mac here: iOS code cannot be compiled in this environment. Match existing idioms (failable `UIColor(hex:)` force-unwrap convention is fine). **Never edit `.storyboard` files** — property changes go in code. Kevin builds in Xcode afterward.
- Contract wording is copied verbatim from Task 1's `lib/format-contract.ts` — do not paraphrase it in other tasks.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: Contract constants + markdown parser + MarkdownText component (web)

**Files:**
- Create: `lib/format-contract.ts`
- Create: `lib/markdown.ts`
- Create: `components/app/MarkdownText.tsx`

**Interfaces:**
- Produces:
  - `FREE_TEXT_FORMAT_CONTRACT: string` and `JSON_FORMAT_CONTRACT: string` (from `@/lib/format-contract`)
  - `parseMarkdownBlocks(input: string): MarkdownBlock[]` and `parseMarkdownInline(text: string): MarkdownInline[]` (from `@/lib/markdown`), where `MarkdownBlock = { kind: "paragraph"; lines: string[] } | { kind: "ul" | "ol"; items: string[] }` and `MarkdownInline = { text: string; strong?: boolean; em?: boolean }`
  - `<MarkdownText text={string} className={string?} />` (from `@/components/app/MarkdownText`)

- [ ] **Step 1: Create `lib/format-contract.ts`**

```ts
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
```

- [ ] **Step 2: Create `lib/markdown.ts`**

Parser rules: `\r\n` normalized to `\n`; blank lines split blocks; within a block, consecutive `- `/`* ` lines → `ul`, consecutive `N. `/`N) ` lines → `ol`, everything else accumulates as paragraph lines. Inline: `**x**` parsed before `*x*`. Anything unrecognized falls through as literal text.

```ts
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
```

- [ ] **Step 3: Create `components/app/MarkdownText.tsx`**

```tsx
import { parseMarkdownBlocks, parseMarkdownInline } from "@/lib/markdown";

interface MarkdownTextProps {
  text: string;
  className?: string;
}

// Renders the Quizlia text subset (see lib/markdown.ts). Pass the text
// styling through className exactly as the old plain <p> had it.
export function MarkdownText({ text, className }: MarkdownTextProps) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className={className}>
      {blocks.map((block, blockIndex) => {
        if (block.kind === "ul" || block.kind === "ol") {
          const Tag = block.kind === "ul" ? "ul" : "ol";
          const markerClass = block.kind === "ul" ? "list-disc" : "list-decimal";
          return (
            <Tag key={blockIndex} className={`${markerClass} pl-5 my-2 space-y-1`}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={blockIndex} className="my-2 first:mt-0 last:mb-0">
            {block.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInline(line)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function renderInline(text: string) {
  return parseMarkdownInline(text).map((segment, index) => {
    if (segment.strong) return <strong key={index}>{segment.text}</strong>;
    if (segment.em) return <em key={index}>{segment.text}</em>;
    return <span key={index}>{segment.text}</span>;
  });
}
```

- [ ] **Step 4: Verify types + lint**

Run: `npx tsc --noEmit`
Expected: no errors (pre-existing ones none in web repo for tsc).

Run: `npx eslint lib/format-contract.ts lib/markdown.ts components/app/MarkdownText.tsx`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/format-contract.ts lib/markdown.ts components/app/MarkdownText.tsx
git commit -m "feat: markdown subset parser + MarkdownText renderer + prompt contract constants

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Enforce the contract in all three server routes (web)

**Files:**
- Modify: `app/api/chat/route.ts` (fullPrompt, ~lines 23–39)
- Modify: `app/api/generate/route.ts` (both parts.push branches, ~lines 189–194; anchors verified against `64efdf4`)
- Modify: `app/api/ios/gemini/[purpose]/route.ts` (upstream fetch body, ~lines 121–132; anchors verified against `64efdf4`)

**Interfaces:**
- Consumes: `FREE_TEXT_FORMAT_CONTRACT`, `JSON_FORMAT_CONTRACT` from `@/lib/format-contract` (Task 1).

- [ ] **Step 1: `app/api/chat/route.ts` — add import + append contract**

Add after the existing imports (line 1–3 area):

```ts
import { FREE_TEXT_FORMAT_CONTRACT } from "@/lib/format-contract";
```

Change the end of `fullPrompt` (currently ends with `- Never make up or assume information not explicitly stated in the context\`;`) to:

```ts
- Never make up or assume information not explicitly stated in the context

${FREE_TEXT_FORMAT_CONTRACT}`;
```

(Keep every existing line of the prompt above it unchanged; only add the blank line + interpolation before the closing backtick.)

- [ ] **Step 2: `app/api/generate/route.ts` — add import + append contract on both branches**

Add import:

```ts
import { JSON_FORMAT_CONTRACT } from "@/lib/format-contract";
```

YouTube branch — change:

```ts
      // Add the prompt after the video
      parts.push({ text: prompt });
```

to:

```ts
      // Add the prompt after the video
      parts.push({ text: `${prompt}\n\n${JSON_FORMAT_CONTRACT}` });
```

Non-YouTube branch — change:

```ts
      // For non-YouTube content, add prompt first
      const fullPrompt = `${prompt}\n\nCONTENT:\n${content}`;
```

to:

```ts
      // For non-YouTube content, add prompt first
      const fullPrompt = `${prompt}\n\nCONTENT:\n${content}\n\n${JSON_FORMAT_CONTRACT}`;
```

- [ ] **Step 3: `app/api/ios/gemini/[purpose]/route.ts` — append contract as last part**

Add import:

```ts
import { FREE_TEXT_FORMAT_CONTRACT, JSON_FORMAT_CONTRACT } from "@/lib/format-contract";
```

Change:

```ts
  try {
    const body = await request.json();

    // Forward only what the Gemini REST API accepts; the model is fixed
    // server-side so it can change without an app release.
    const upstream = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: body.contents,
        generationConfig: body.generationConfig,
      }),
    });
```

to:

```ts
  try {
    const body = await request.json();

    // Append the format contract as the LAST text part so it takes
    // precedence over prompt text older app versions still send.
    const contract = purpose === "chat" ? FREE_TEXT_FORMAT_CONTRACT : JSON_FORMAT_CONTRACT;
    const contents = Array.isArray(body.contents) ? [...body.contents] : [];
    if (contents[0] && Array.isArray(contents[0].parts)) {
      contents[0] = { ...contents[0], parts: [...contents[0].parts, { text: contract }] };
    }

    // Forward only what the Gemini REST API accepts; the model is fixed
    // server-side so it can change without an app release.
    const upstream = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: body.generationConfig,
      }),
    });
```

- [ ] **Step 4: Verify types + lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint app/api/chat/route.ts app/api/generate/route.ts "app/api/ios/gemini/[purpose]/route.ts"`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/route.ts app/api/generate/route.ts "app/api/ios/gemini/[purpose]/route.ts"
git commit -m "feat: append format contract to chat, generate, and ios proxy prompts

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Topic page rendering (web)

**Files:**
- Modify: `app/note/topic/[id]/page.tsx` (~660 section content, ~798 explanation, ~845 AI bubble)

**Interfaces:**
- Consumes: `<MarkdownText text className />` from `@/components/app/MarkdownText` (Task 1).
- `messages` state element type is `{ id: string; sender: "user" | "ai" | "typing" | "default"; text: string }` — `message.text` is a non-optional `string`.

- [ ] **Step 1: Add import** (top of file, after the other `@/` imports)

```tsx
import { MarkdownText } from "@/components/app/MarkdownText";
```

- [ ] **Step 2: Section content (~line 660)** — change:

```tsx
                          <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
                            {section.content}
                          </p>
```

to:

```tsx
                          <MarkdownText
                            text={section.content}
                            className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed"
                          />
```

- [ ] **Step 3: Quiz explanation (~line 798)** — change:

```tsx
                      {question.explanation && (
                        <div className="mt-3 ml-8 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-sm text-blue-800 dark:text-blue-200">
                          <span className="font-medium">Explanation:</span> {question.explanation}
                        </div>
                      )}
```

to:

```tsx
                      {question.explanation && (
                        <div className="mt-3 ml-8 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-sm text-blue-800 dark:text-blue-200 [&_strong]:font-semibold">
                          <span className="font-medium">Explanation:</span>
                          <MarkdownText text={question.explanation} />
                        </div>
                      )}
```

(If `question.explanation` is typed optional and tsc complains inside the JSX, guard is already present via `&&` — narrowing holds.)

- [ ] **Step 4: AI chat bubble (~line 845)** — change:

```tsx
                {message.sender === "ai" && (
                  <div className="bg-gray-100 dark:bg-gray-800 rounded-xl rounded-bl-sm p-3 max-w-[85%]">
                    <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap">{message.text}</p>
                  </div>
                )}
```

to:

```tsx
                {message.sender === "ai" && (
                  <div className="bg-gray-100 dark:bg-gray-800 rounded-xl rounded-bl-sm p-3 max-w-[85%]">
                    <MarkdownText text={message.text} className="text-sm text-gray-900 dark:text-white" />
                  </div>
                )}
```

- [ ] **Step 5: Verify types + lint**

Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint "app/note/topic/[id]/page.tsx"` → no errors.

- [ ] **Step 6: Commit**

```bash
git add "app/note/topic/[id]/page.tsx"
git commit -m "feat: topic page renders markdown subset (sections, explanations, chat)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Remaining render sites (web)

**Files:**
- Modify: `components/app/ContentViewModal.tsx` (~292 summary, ~385 quiz explanation, ~432 chat bubble)
- Modify: `components/study-guide/CheatSheetSection.tsx` (~28 section content; delete ~54–61 helper)
- Modify: `components/study-guide/InteractiveQuiz.tsx` (~249 explanation)
- Modify: `app/note/[slug]/page.tsx` (~318 quick_summary, ~346 detailed_notes)

**Interfaces:**
- Consumes: `<MarkdownText text className />` from `@/components/app/MarkdownText` (Task 1).

- [ ] **Step 1: `ContentViewModal.tsx` — add import, then three swaps**

Add import:

```tsx
import { MarkdownText } from "@/components/app/MarkdownText";
```

Summary (~292) — change:

```tsx
                    <p className="text-gray-700 dark:text-gray-300 leading-relaxed">{content.data.quick_summary}</p>
```

to:

```tsx
                    <MarkdownText text={content.data.quick_summary} className="text-gray-700 dark:text-gray-300 leading-relaxed" />
```

Quiz explanation (~385) — change:

```tsx
                        <p className="text-gray-700 dark:text-gray-300 mt-1 text-sm">
                          {quiz.explanation}
                        </p>
```

to:

```tsx
                        <MarkdownText text={quiz.explanation} className="text-gray-700 dark:text-gray-300 mt-1 text-sm" />
```

Chat bubble (~432) — change:

```tsx
                          <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap">{message.text}</p>
```

to:

```tsx
                          <MarkdownText text={message.text} className="text-sm text-gray-900 dark:text-white" />
```

- [ ] **Step 2: `CheatSheetSection.tsx` — swap content render, delete dead helper**

Add import (next to the existing `@/lib/studyGuide` import):

```tsx
import { MarkdownText } from "@/components/app/MarkdownText";
```

Change (~28):

```tsx
            <div className="text-white/70 leading-relaxed font-rethink-sans whitespace-pre-line mb-4">
              {highlightKeyTerms(section.content, section.keyTerms)}
            </div>
```

to:

```tsx
            <MarkdownText
              text={section.content}
              className="text-white/70 leading-relaxed font-rethink-sans mb-4 [&_strong]:text-white"
            />
```

Delete the now-unused helper at the bottom of the file (lines ~54–61):

```tsx
// Helper to highlight key terms in content
function highlightKeyTerms(content: string, keyTerms?: string[]): React.ReactNode {
  if (!keyTerms || keyTerms.length === 0) return content;

  let result = content;
  // Terms are already shown below, so we just return content as-is
  return content;
}
```

- [ ] **Step 3: `InteractiveQuiz.tsx` — explanation body**

Add import:

```tsx
import { MarkdownText } from "@/components/app/MarkdownText";
```

Change (~248):

```tsx
          {showExplanation && (
            <div className="mt-3 bg-white/5 rounded-xl p-4 text-white/70 text-sm leading-relaxed font-rethink-sans">
              {currentQuiz.explanation}
            </div>
          )}
```

to:

```tsx
          {showExplanation && (
            <div className="mt-3 bg-white/5 rounded-xl p-4">
              <MarkdownText
                text={currentQuiz.explanation}
                className="text-white/70 text-sm leading-relaxed font-rethink-sans [&_strong]:text-white"
              />
            </div>
          )}
```

- [ ] **Step 4: `[slug]/page.tsx` — quick_summary + detailed_notes**

Add import:

```tsx
import { MarkdownText } from "@/components/app/MarkdownText";
```

Quick summary (~318) — change:

```tsx
                    <p className="text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
                      {topic.note.quick_summary}
                    </p>
```

to:

```tsx
                    <MarkdownText
                      text={topic.note.quick_summary}
                      className="text-gray-700 dark:text-gray-300 leading-relaxed"
                    />
```

Detailed notes (~346) — change:

```tsx
                      <p className="text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
                        {topic.note.detailed_notes}
                      </p>
```

to:

```tsx
                      <MarkdownText
                        text={topic.note.detailed_notes}
                        className="text-gray-700 dark:text-gray-300 leading-relaxed"
                      />
```

(Both are guarded by `&&` on the value in the existing JSX — keep those guards; MarkdownText's `text` prop is `string`, and the guards narrow it.)

- [ ] **Step 5: Verify types + lint**

Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint components/app/ContentViewModal.tsx components/study-guide/CheatSheetSection.tsx components/study-guide/InteractiveQuiz.tsx "app/note/[slug]/page.tsx"` → no errors.

- [ ] **Step 6: Commit**

```bash
git add components/app/ContentViewModal.tsx components/study-guide/CheatSheetSection.tsx components/study-guide/InteractiveQuiz.tsx "app/note/[slug]/page.tsx"
git commit -m "feat: remaining surfaces render markdown subset (modal, cheat sheet, quiz, public guide)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Web full verification + hand-off checklist

**Files:** none (verification only)

- [ ] **Step 1: Run the three gates**

Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint app/api/chat/route.ts app/api/generate/route.ts "app/api/ios/gemini/[purpose]/route.ts" lib/format-contract.ts lib/markdown.ts components/app/MarkdownText.tsx "app/note/topic/[id]/page.tsx" components/app/ContentViewModal.tsx components/study-guide/CheatSheetSection.tsx components/study-guide/InteractiveQuiz.tsx "app/note/[slug]/page.tsx"` → no new errors.
Run: `npm run build` → succeeds.

- [ ] **Step 2: Hand the click-through checklist to Kevin** (a dev server may already be running on port 3000 — reuse it; this Next version refuses a second one per directory):

1. Open an **old** saved note — content should look unchanged (plain paragraphs).
2. Generate a **new** note from list-heavy content — cheat-sheet sections should show real bullets/numbering and bold terms instead of literal `**`/`-`.
3. In the note's chat tab ask: "List the 3 most important points as bullet points" — the answer must render as a bulleted list.
4. Open a **published guide** (`/note/<slug>`) — quick summary + detailed notes render the subset.
5. Quiz result explanation shows bold/list rendering.
6. Toggle dark mode on one of the above.

- [ ] **Step 3: No commit** (nothing changed). Kevin pushes when ready — the push deploys the contract to Netlify and activates it for all installed iOS versions.

---

### Task 6: MarkdownFormatter (iOS)

**Files:**
- Create: `QuickNote/Resource/MarkdownFormatter.swift` (repo root `e:\Projects\Arasheed\QuickNote\QuickNote`; synchronized folder groups mean new files are picked up by Xcode automatically — no pbxproj edit)

**Interfaces:**
- Produces:
  - `MarkdownFormatter.attributed(from:font:color:) -> NSAttributedString`
  - `MarkdownFormatter.html(from:) -> String`
- Parses the same subset as web's `lib/markdown.ts`: `**bold**`, `*italic*`, `- ` bullets, `1. `/`1) ` ordered items, blank-line paragraphs.

- [ ] **Step 1: Create `QuickNote/Resource/MarkdownFormatter.swift`**

```swift
import UIKit

/// Parses the Quizlia text subset — the format every prompt contract asks
/// the model for: **bold**, *italic*, "- " bullet lists, "1. " numbered
/// lists, and blank-line-separated paragraphs. Plain text parses as plain
/// paragraphs, so content saved before the contract renders unchanged.
enum MarkdownFormatter {

    // MARK: - Public

    /// Attributed string for the chat bubble label.
    static func attributed(from text: String, font baseFont: UIFont, color baseColor: UIColor) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let boldFont = UIFont(name: "Roboto-Bold", size: baseFont.pointSize) ?? UIFont.boldSystemFont(ofSize: baseFont.pointSize)
        let italicFont: UIFont
        if let italicDescriptor = baseFont.fontDescriptor.withSymbolicTraits(.traitItalic) {
            italicFont = UIFont(descriptor: italicDescriptor, size: baseFont.pointSize)
        } else {
            italicFont = baseFont
        }

        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.paragraphSpacing = 6
        paragraphStyle.lineBreakMode = .byWordWrapping

        // Hanging indent so wrapped list lines align after the marker.
        let listStyle = NSMutableParagraphStyle()
        listStyle.paragraphSpacing = 4
        listStyle.firstLineHeadIndent = 0
        listStyle.headIndent = 14
        listStyle.lineBreakMode = .byWordWrapping

        let baseAttributes: [NSAttributedString.Key: Any] = [
            .font: baseFont,
            .foregroundColor: baseColor,
            .paragraphStyle: paragraphStyle
        ]

        for (blockIndex, block) in parse(text).enumerated() {
            if blockIndex > 0 {
                result.append(NSAttributedString(string: "\n", attributes: baseAttributes))
            }
            switch block {
            case .paragraph(let lines):
                for (lineIndex, line) in lines.enumerated() {
                    if lineIndex > 0 {
                        result.append(NSAttributedString(string: "\n", attributes: baseAttributes))
                    }
                    appendInline(line, to: result, baseFont: baseFont, boldFont: boldFont, italicFont: italicFont, baseColor: baseColor, paragraphStyle: paragraphStyle)
                }
            case .bulletList(let items):
                for item in items {
                    appendInline("• " + item, to: result, baseFont: baseFont, boldFont: boldFont, italicFont: italicFont, baseColor: baseColor, paragraphStyle: listStyle)
                }
            case .numberedList(let items):
                for (itemIndex, item) in items.enumerated() {
                    appendInline("\(itemIndex + 1). " + item, to: result, baseFont: baseFont, boldFont: boldFont, italicFont: italicFont, baseColor: baseColor, paragraphStyle: listStyle)
                }
            }
        }
        return result
    }

    /// HTML for the webview-based screens (NoteViewController,
    /// ExplainViewController). Escapes first, then maps the subset onto
    /// the tags those screens already style (b, ul, li, p).
    static func html(from text: String) -> String {
        var html = ""
        for block in parse(text) {
            switch block {
            case .paragraph(let lines):
                html += "<p>" + lines.map { inlineHTML($0) }.joined(separator: "<br>") + "</p>"
            case .bulletList(let items):
                html += "<ul>" + items.map { "<li>" + inlineHTML($0) + "</li>" }.joined() + "</ul>"
            case .numberedList(let items):
                html += "<ol>" + items.map { "<li>" + inlineHTML($0) + "</li>" }.joined() + "</ol>"
            }
        }
        return html
    }

    // MARK: - Parsing

    private enum Block {
        case paragraph([String])
        case bulletList([String])
        case numberedList([String])
    }

    private static func parse(_ input: String) -> [Block] {
        let normalized = input.replacingOccurrences(of: "\r\n", with: "\n")
        var blocks: [Block] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbers: [String] = []

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph)); paragraph = [] }
            if !bullets.isEmpty { blocks.append(.bulletList(bullets)); bullets = [] }
            if !numbers.isEmpty { blocks.append(.numberedList(numbers)); numbers = [] }
        }

        for rawLine in normalized.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                flush()
                continue
            }
            if line.hasPrefix("- ") && line.count > 2 {
                if !paragraph.isEmpty || !numbers.isEmpty { flush() }
                bullets.append(String(line.dropFirst(2)))
            } else if let item = orderedListItem(line) {
                if !paragraph.isEmpty || !bullets.isEmpty { flush() }
                numbers.append(item)
            } else {
                if !bullets.isEmpty || !numbers.isEmpty { flush() }
                paragraph.append(line)
            }
        }
        flush()
        return blocks
    }

    /// "1. item" or "1) item" → "item"; anything else returns nil.
    private static func orderedListItem(_ line: String) -> String? {
        guard let spaceIndex = line.firstIndex(of: " ") else { return nil }
        let marker = line[line.startIndex..<spaceIndex]
        guard marker.count >= 2 else { return nil }
        guard marker.last == "." || marker.last == ")" else { return nil }
        let digits = marker.dropLast()
        guard !digits.isEmpty, digits.allSatisfy({ $0.isNumber }) else { return nil }
        return String(line[line.index(after: spaceIndex)...])
    }

    // MARK: - Inline

    private static let inlinePattern = try! NSRegularExpression(pattern: "\\*\\*([^*]+)\\*\\*|\\*([^*]+)\\*")

    private static func appendInline(_ line: String,
                                     to result: NSMutableAttributedString,
                                     baseFont: UIFont,
                                     boldFont: UIFont,
                                     italicFont: UIFont,
                                     baseColor: UIColor,
                                     paragraphStyle: NSParagraphStyle) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: baseFont,
            .foregroundColor: baseColor,
            .paragraphStyle: paragraphStyle
        ]
        let nsLine = line as NSString
        let matches = inlinePattern.matches(in: line, range: NSRange(location: 0, length: nsLine.length))
        if matches.isEmpty {
            result.append(NSAttributedString(string: line, attributes: attributes))
            return
        }
        var cursor = 0
        for match in matches {
            if match.range.location > cursor {
                result.append(NSAttributedString(string: nsLine.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), attributes: attributes))
            }
            if match.range(at: 1).location != NSNotFound {
                result.append(NSAttributedString(string: nsLine.substring(with: match.range(at: 1)), attributes: [.font: boldFont, .foregroundColor: baseColor, .paragraphStyle: paragraphStyle]))
            } else {
                result.append(NSAttributedString(string: nsLine.substring(with: match.range(at: 2)), attributes: [.font: italicFont, .foregroundColor: baseColor, .paragraphStyle: paragraphStyle]))
            }
            cursor = match.range.location + match.range.length
        }
        if cursor < nsLine.length {
            result.append(NSAttributedString(string: nsLine.substring(from: cursor), attributes: attributes))
        }
    }

    // MARK: - HTML

    private static func inlineHTML(_ line: String) -> String {
        var text = escaped(line)
        text = replace(pattern: "\\*\\*([^*]+)\\*\\*", in: text, template: "<b>$1</b>")
        text = replace(pattern: "\\*([^*]+)\\*", in: text, template: "<i>$1</i>")
        return text
    }

    private static func escaped(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private static func replace(pattern: String, in text: String, template: String) -> String {
        let regex = try! NSRegularExpression(pattern: pattern)
        let nsText = text as NSString
        return regex.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: nsText.length), withTemplate: template)
    }
}
```

- [ ] **Step 2: Review against existing idioms** (no compile available): `enum` with static members matches `QuicNotesPrompts`; `try!` on compile-time-constant regexes is a programmer-error assertion, consistent with the codebase's force-unwrap convention.

- [ ] **Step 3: Commit (iOS repo)**

```bash
cd /e/Projects/Arasheed/QuickNote/QuickNote
git add QuickNote/Resource/MarkdownFormatter.swift
git commit -m "feat: MarkdownFormatter parses the prompt-contract text subset

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Wire iOS render sites

**Files:**
- Modify: `QuickNote/ViewController/ChatViewController.swift` (`.ai` case in `cellForRowAt`, ~lines 137–145)
- Modify: `QuickNote/ViewController/NoteViewController.swift` (CSS block + summary line + section content line in `makeHTML`)
- Modify: `QuickNote/ViewController/ExplainViewController.swift` (explanation line in `makeHTML`, ~line 66)

**Interfaces:**
- Consumes: `MarkdownFormatter.attributed(from:font:color:)` and `MarkdownFormatter.html(from:)` (Task 6).

- [ ] **Step 1: `ChatViewController.swift` — attributed chat bubble**

Change:

```swift
        case .ai:
            let cell = tableView.dequeueReusableCell(withIdentifier: "AiResponseTableViewCell", for: indexPath) as! AiResponseTableViewCell
            cell.lblAiRespone.text = msg.text
            DispatchQueue.main.async {
                cell.viewBg.applyMultiColorGradientBorder(to: cell.viewBg, cornerRadius: 14, borderWidth: 0.5,cornerStyles: [.topLeft,.topRight,.bottomRight])
            }
            return cell
```

to:

```swift
        case .ai:
            let cell = tableView.dequeueReusableCell(withIdentifier: "AiResponseTableViewCell", for: indexPath) as! AiResponseTableViewCell
            cell.lblAiRespone.numberOfLines = 0
            cell.lblAiRespone.attributedText = MarkdownFormatter.attributed(
                from: msg.text ?? "",
                font: cell.lblAiRespone.font,
                color: cell.lblAiRespone.textColor
            )
            DispatchQueue.main.async {
                cell.viewBg.applyMultiColorGradientBorder(to: cell.viewBg, cornerRadius: 14, borderWidth: 0.5,cornerStyles: [.topLeft,.topRight,.bottomRight])
            }
            return cell
```

- [ ] **Step 2: `NoteViewController.swift` — section-scoped CSS**

In `makeHTML`'s `<style>` block, immediately after the existing `.section-content { ... }` rule, add:

```css
                .section-content p { margin: 6px 0; }
                .section-content ul { margin: 8px 0 8px 20px; }
                .section-content ol { margin: 8px 0 8px 20px; }
                .section-content li { margin: 4px 0; }
```

(These override the global `p/ul/li` margins inside section cards so multi-paragraph content doesn't balloon the card.)

- [ ] **Step 3: `NoteViewController.swift` — summary + section content through the formatter**

Change:

```swift
        if let summary = note.quick_summary {
            html += "<p><b>\(isQuickSummary)</b><br>\(summary)</p>"
        }
```

to:

```swift
        if let summary = note.quick_summary {
            html += "<p><b>\(isQuickSummary)</b></p>" + MarkdownFormatter.html(from: summary)
        }
```

Change:

```swift
                if let content = section.content, !content.isEmpty {
                    html += "<p class='section-content'>\(content)</p>"
                }
```

to:

```swift
                if let content = section.content, !content.isEmpty {
                    html += "<div class='section-content'>" + MarkdownFormatter.html(from: content) + "</div>"
                }
```

(`div` not `p` so the formatter's inner `<p>`/`<ul>` elements aren't nested invalidly; the class styles inherit.)

- [ ] **Step 4: `ExplainViewController.swift` — explanation through the formatter**

Change (inside the `"""` HTML template):

```swift
            <h2>\(header)</h2>
            <p><b>\("kExplanation".localized())</b><br>\(note)</p>
```

to:

```swift
            <h2>\(header)</h2>
            <p><b>\("kExplanation".localized())</b></p>
            \(MarkdownFormatter.html(from: note))
```

- [ ] **Step 5: Review** — no storyboard files touched; `numberOfLines = 0` set in code; `msg.text` is `String?` on `ChatMessage` so `?? ""` is required.

- [ ] **Step 6: Commit (iOS repo)**

```bash
cd /e/Projects/Arasheed/QuickNote/QuickNote
git add QuickNote/ViewController/ChatViewController.swift QuickNote/ViewController/NoteViewController.swift QuickNote/ViewController/ExplainViewController.swift
git commit -m "feat: chat bubble, note body, and explanations render the text subset

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Reword contradicting prompt lines (iOS)

**Files:**
- Modify: `QuickNote/GeminiApi/GeminiApiManger.swift` (~line 265 and ~lines 329–330)

**Interfaces:** none (text only; server appends the authoritative contract — this stops the shipped prompt from contradicting it).

- [ ] **Step 1: Line ~265** — change:

```swift
        - NO markdown formatting.
```

to:

```swift
        - The JSON itself must stay plain: no markdown fences, no text outside the JSON object.
```

- [ ] **Step 2: Lines ~329–330** — change:

```swift
        You are not allowed to output markdown, code blocks, explanations,
        apologies, or any text outside the JSON object.
```

to:

```swift
        You are not allowed to output code blocks, explanations,
        apologies, or any text outside the JSON object. Inside explanatory
        string values (note section content, quick_summary, quiz
        explanations) you may use **bold**, *italic*, "- " bullet lists,
        "1. " numbered lists, and blank lines between paragraphs —
        nothing else.
```

(These sit inside a Swift multiline string with `\(...)` interpolation — the added `**`/`*` literals are safe; do not touch the neighboring `- NO \`\`\`json ...` line, which stays consistent with the contract.)

- [ ] **Step 3: Commit (iOS repo)**

```bash
cd /e/Projects/Arasheed/QuickNote/QuickNote
git add QuickNote/GeminiApi/GeminiApiManger.swift
git commit -m "fix: multi-prompt allows the text subset inside prose values

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: iOS hand-off (no code)

- [ ] **Step 1: Hand Kevin the Xcode checklist:**

1. Build and run; open an existing note — body should look unchanged.
2. Generate a new note from list-heavy content — section cards show bullets/bold (yellow bold per existing `b` CSS).
3. In the note's Chat tab ask for a bulleted list — the bubble renders `•` items with hanging indent and bold terms.
4. Answer a quiz question and expand the explanation — bold/lists render.

- [ ] **Step 2: No commit.** Kevin builds/verifies; any fixes come back as follow-up edits.

---

## Self-Review (already applied while writing)

- **Spec coverage:** contract constants + 3 routes (spec §Enforcement) → Tasks 1–2; web plug-in points incl. `detailed_notes` addendum → Tasks 3–4; iOS formatter + 3 render sites + CSS → Tasks 6–7; prompt rewording → Task 8; verification per repo workflow → Tasks 5 & 9. Out-of-scope items (`NoteMoreViewController` sections gap, flashcard/quiz structured fields) intentionally untouched.
- **Placeholders:** none — every step carries full code.
- **Type consistency:** `MarkdownText` props (`text: string`, `className?: string`) used identically in Tasks 3–4; `MarkdownFormatter.attributed(from:font:color:)` / `html(from:)` signatures match between Tasks 6 and 7; `parseMarkdownBlocks`/`parseMarkdownInline` names match between Task 1's lib and component.
