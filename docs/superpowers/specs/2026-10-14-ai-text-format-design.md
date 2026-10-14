# AI text format contract + rendering — design

Date: 2026-10-14
Repos: `quizlia_landing` (web) + `Quizliai-iOS` (iOS working copy `QuickNote`)

## Problem

Model output has no defined format contract anywhere. Chat prompts say nothing
about formatting, so Gemini freely emits markdown; both UIs dump the raw string
into plain-text views, so users see literal `**bold**`, `##`, and `-` symbols.
Note generation swings the other way — the iOS multi-prompt bluntly bans all
markdown ("NO markdown formatting"), flattening note content. Quiz explanations
are the same unconstrained free-text surface.

Surfaces today:

- **Web chat**: `/api/chat` prompt has no format rules; rendered as plain
  `whitespace-pre-wrap` paragraphs in the topic-page chat tab and
  `ContentViewModal`.
- **iOS chat**: `ChatViewController` renders the answer in a plain `UILabel`
  (`lblAiRespone.text`).
- **Web notes**: `/api/generate` JSON has unconstrained `sections[].content` /
  `quick_summary` strings, rendered as plain text (topic page, public guide
  `[slug]`, `CheatSheetSection`, `ContentViewModal`).
- **iOS notes**: JSON strings rendered via hand-built HTML in
  `NoteViewController` (newlines collapse inside `<p>`; no emphasis possible).
- **Quiz explanations**: plain render in `InteractiveQuiz`, topic page,
  `ContentViewModal`, and iOS `ExplainViewController`.

## Decision

Standardize on a **constrained markdown subset**, enforced in prompts, rendered
by a small hand-rolled parser on each platform. No new dependencies on either
side.

### The subset

Allowed: `**bold**`, `*italic*`, `- ` bullet lists, `1. ` numbered lists,
blank-line paragraph breaks.

Banned (prompts say "never use"): headings (`#`), tables, code fences/blocks,
links, images, raw HTML, any other markdown syntax.

Key property: plain text is a valid instance of the subset, so every saved
note/chat in Firestore and SQLite renders identically or better after the
change. No migration.

### Contract text (canonical wording)

Free-text surfaces (chat answers):

```
FORMAT:
- Use only these formatting constructs: **bold** for key terms, *italic* for emphasis, "- " for bullet lists, "1. " for numbered lists, and blank lines between paragraphs.
- Never use headings (#), tables, code blocks, links, images, or any other markdown syntax.
```

JSON surfaces (note/quiz/onboarding generation):

```
FORMAT:
- The JSON itself must stay plain: no markdown fences, no text outside the JSON.
- Inside explanatory prose values (section content, quick_summary, quiz explanations) use only: **bold**, *italic**, "- " bullet lists, "1. " numbered lists, blank lines between paragraphs.
- Keep titles, captions, key findings and important-notes items, flashcard questions/answers, and quiz questions/options plain — no emphasis or list markers.
- Never use headings (#), tables, code blocks, links, images, or any other markdown syntax.
```

### Surfaces in scope

| Surface | Gets contract | Gets renderer |
|---|---|---|
| Chat answers (web + iOS) | yes (free-text variant) | yes |
| Note `sections[].content` + `quick_summary` | yes (JSON variant) | yes |
| Quiz explanations | yes (JSON variant) | yes |

Explicitly out of scope / stays plain single-line: flashcard Q&A, quiz
questions/options, captions, titles — the JSON schema already structures them.

## Enforcement point

All iOS Gemini calls now flow through the server proxy
(`/api/ios/gemini/[purpose]` on quizliai.com), which forwards `body.contents`
verbatim. The contract is therefore enforced server-side — one web deploy
activates it for every installed iOS version, no app release needed:

- `lib/format-contract.ts` (new): exports both contract variants above.
- `/api/chat`: append free-text block to `fullPrompt`.
- `/api/generate`: append JSON block to the task prompt.
- `/api/ios/gemini/[purpose]`: before forwarding, append the right variant as
  the **last** `parts` text entry (later instructions win, overriding the old
  "NO markdown" lines fielded app versions still send). `chat` → free-text;
  `generation` + `onboarding` → JSON variant.

iOS repo (next release): reword the two contradictory lines in
`GeminiApiManger.swift` ("NO markdown formatting" and "You are not allowed to
output markdown…") so the shipped prompt agrees with the server contract.

Accepted wrinkle: until the reworded iOS build ships, the model sees both the
old ban and the appended contract. Last-part-wins plus a renderer that handles
plain text makes the worst case "old-style flat notes" — today's behavior.

## Web rendering

New `components/app/MarkdownText.tsx`, zero dependencies:

- Props: `text: string`, `className?: string` (text styling flows through).
- Parsing is total and dumb: blank lines split blocks; consecutive `- ` lines →
  `<ul>`; consecutive `1. ` lines → `<ol>`; otherwise `<p>`. Inline: `**x**` →
  `<strong>`, `*x*` → `<em>` (bold parsed before italic). Unrecognized syntax
  (stray `##`, tables, fences) renders as literal text — never crashes, never
  half-renders. React escapes everything; no new injection surface.

Plug-in points (replace plain-text renders):

- `app/note/topic/[id]/page.tsx`: AI chat bubble (~847), section content
  (~660), quiz explanation (~800).
- `components/app/ContentViewModal.tsx`: chat bubble (~432), quick_summary
  (~292), quiz explanation (~385).
- `app/note/[slug]/page.tsx`: `quick_summary` render (~319; built from
  `guide.tldr`) and `detailed_notes` (~346) — same prose class. Section
  content renders via `CheatSheetSection` — covered below. No quiz on the
  public guide page.
- `components/study-guide/CheatSheetSection.tsx`: section content (replacing
  the `highlightKeyTerms` pass-through).
- `components/study-guide/InteractiveQuiz.tsx`: explanation (~250).

Plain-text content keeps its current visual weight (same Tailwind classes);
lists get real bullets/numbering and emphasis gets real weight.

## iOS rendering

New `Resource/MarkdownFormatter.swift` (beside FontManager/GradientManager),
one parser, two entry points:

1. `attributed(from:baseLabel:) -> NSAttributedString` — chat bubble. Reads the
   label's existing font/color as base; applies paragraph spacing, `•` bullets
   with hanging indent, numbers for ordered runs, `**bold**` → Roboto-Bold
   (fallback bold system font), `*italic*` → italic descriptor (graceful
   fallback to regular). Confirm `numberOfLines = 0` on `lblAiRespone`.
2. `html(from:) -> String` — for webview screens. HTML-escapes first, then
   paragraphs → `<p>`, lists → `<ul>/<ol>/<li>`, `**x**` → `<b>`, `*x*` →
   `<i>`. Lands on CSS those screens already define (NoteViewController and
   ExplainViewController style `b`, `ul`, `li`) — no CSS redesign.

Changes:

- `ChatViewController` `.ai` case: `lblAiRespone.attributedText =
  MarkdownFormatter.attributed(...)`.
- `NoteViewController.makeHTML`: `quick_summary` + each `section.content`
  pass through `html(from:)`.
- `ExplainViewController.makeHTML`: explanation passes through `html(from:)`.

Known pre-existing gap, deliberately out of scope:
`NoteMoreViewController.makeHTML` (share/PDF export) doesn't render
cheat-sheet sections at all.

## Verification

Web: `npx tsc --noEmit`, eslint on changed files (ignore the 6 pre-existing),
`npm run build`, then hand click-through: old note (unchanged), new note with
lists, list-y chat answer, public guide page, dark mode.

iOS: no Mac on this machine — code review against existing idioms (e.g.
failable `UIColor(hex:)` force-unwrap convention), then Kevin builds in Xcode
and eyeballs the same scenarios.

## Rollout order

1. Web repo: contract + MarkdownText + plug-in points. Push to main
   auto-deploys to Netlify — the proxy change activates the contract for
   fielded iOS apps.
2. iOS repo: MarkdownFormatter + three render sites + prompt rewording.
