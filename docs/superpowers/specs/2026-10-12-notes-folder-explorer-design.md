# My Notes Folder Explorer — Design

Date: 2026-10-12
Status: Approved
Scope: Web app only (`quizlia_landing`). No iOS changes, no storage/Firebase changes.

## Problem

The web "My Notes" tab (`/note/notes`) shows a flat topic list with a chip bar that *filters* by folder. Folders are never opened or navigated into, "New Folder" is a small chip at the end of the bar, and there is no way to generate content from the My Notes page (the generator lives only on the dashboard).

The iOS app works like a file explorer: a Folders grid on the home screen, tapping a folder pushes a folder view (`ListingFolderNoteViewController`) with a back button, a more-menu (rename/delete), the notes inside that folder, and a create-note button that files the new note into that folder.

## Goal

Make the web My Notes tab match the iOS interaction model:

1. My Notes root is a file-explorer tile grid (All Notes, Unsorted, user folders).
2. Tapping a tile drills into that folder's notes; browser Back/forward and refresh behave like a real file manager (URL-driven navigation).
3. A toolbar pairs **Generate Content** and **New Folder** buttons; generating from inside a folder files the new note into that folder (iOS parity).

## Interface

### Root view — `/note/notes`

- Header: "My Notes" + subtitle (`N topics · M folders`).
- Toolbar (top-right): primary **Generate Content** button (`btn-primary` style) with **New Folder** beside it.
- Tile grid, responsive (2 columns mobile → 5–6 desktop):
  - Special tiles first: **All Notes** (total count) and **Unsorted** (unsorted count).
  - User folder tiles: emoji icon, name, note count. Hover lift; click navigates to `?folder=<id>`.
- No folders yet: only the two special tiles + a hint to create a folder.

### Folder view — `/note/notes?folder=<id|all|none>`

- Back button → root (browser Back equivalent).
- Title = folder name (or "All Notes" / "Unsorted"); subtitle = note count.
- User folders only: ⋯ menu with **Rename** (existing `RenameModal`) and **Delete** (existing confirm flow — topics return to Unsorted).
- Notes list: existing topic cards (extracted to `TopicCard`), keeping the existing actions menu (rename / move / delete / share). The inline per-card folder `<select>` is removed; moving happens via the actions menu's Move-to-folder dialog.
- Empty folder: "No notes in <folder> yet" + a **Generate Content** button that opens the sheet with that folder preselected.

### Generate sheet

- Modal over My Notes containing the same form as today's dashboard: content-type tabs (URL / PDF / YouTube / Image), input, Generate button.
- Same processing modal, usage-limit/paywall behavior, and success/error toasts as the dashboard.
- Folder targeting is implicit (no picker in the sheet, matching iOS): launched from a folder view → new notes go into that folder, shown as a "Saving to: <folder>" hint in the sheet; launched from root → new notes are unsorted.
- Dashboard keeps its inline form, rebuilt on the same extracted component so both stay identical.

## Architecture

### New files

| File | Responsibility |
|---|---|
| `hooks/useGenerateContent.ts` | Generation logic extracted from `app/note/page.tsx`: content type, input/file state, `canGenerate` usage check, the three parallel `/api/generate` calls, save via `persistProfileContent`, toasts, processing/paywall state. New `targetFolderId?` param stamps `folderId` on created content items. Supports an `onGenerated` callback. |
| `components/app/GenerateContentForm.tsx` | Tabs + input + Generate button UI, driven by the hook. Props: `profile`, `targetFolderId?`, `onGenerated?`. |
| `components/app/GenerateContentSheet.tsx` | Modal wrapper around `GenerateContentForm` for My Notes. |
| `components/app/notes/FolderTile.tsx` | One tile: icon, name, count; click → `router.push(?folder=id)`. |
| `components/app/notes/TopicCard.tsx` | Existing topic card markup extracted from the notes page; keeps `ItemActionsMenu`; drops the inline folder select. |

### Changed files

| File | Change |
|---|---|
| `app/note/notes/page.tsx` | Rewritten as the explorer: reads `useSearchParams()`, renders root or folder view; keeps all folder CRUD handlers and existing modals (`CreateFolderModal`, `RenameModal`, `MoveFolderModal`). |
| `app/note/page.tsx` | Dashboard swaps its inline generator form for `GenerateContentForm`; layout and behavior unchanged. |

### Data

No storage changes. Folders remain in `localStorage folders_<profileId>`; topics remain managed by `lib/notesSync` (`persistProfileContent` / `loadProfileContent`) with `folderId` on content items. The Firebase shared-sync work on this branch is untouched.

### Navigation & edge cases

- `?folder=<unknown-id>` → silently render root.
- Deleting the folder currently being viewed → `router.replace("/note/notes")`.
- `useSearchParams` requires a `<Suspense>` boundary in this Next.js version; the page body is wrapped. Exact conventions verified against `node_modules/next/dist/docs/` before implementation (per AGENTS.md — this Next version has breaking changes).

## Verification

No test framework exists in the repo; verification matches repo conventions:

1. `npm run lint`
2. `npm run build`
3. Manual browser pass: root grid → create folder → generate into folder from the sheet → move a note via the actions menu → delete the folder while inside it → browser Back through the navigation stack → dark mode + mobile width.

## Out of scope

- Nested folders (single level, matching iOS).
- Folder search/sorting.
- Any iOS app changes.
- Folder storage migration or Firebase folder sync.
