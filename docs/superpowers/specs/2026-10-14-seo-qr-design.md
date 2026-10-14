# SEO Sitemap + App Store QR — Design Spec

Date: 2026-10-14
Status: Approved

## Problem

quizliai.com has no sitemap, no per-page metadata on public notes, and no
Search Console presence — Google can't discover or properly index the public
study guides / user-published notes. Competitor coconote.app converts web
visitors to app users with a visible App Store QR code; QuizliAI's site links
to the App Store only as a text button in the header.

## Goals

1. An auto-updating `sitemap.xml` covering every publicly accessible note
   (`/note/<slug>`), refreshed per publish without a redeploy, plus
   `robots.txt` pointing at it and real per-note metadata for indexing.
2. An App Store QR code on the landing page (hero card + footer block)
   targeting `https://apps.apple.com/us/app/quizliai/id6751740981`.

## Decisions

- **Sitemap scope: ALL accessible notes** — curated guides (`listed: true`)
  AND user-published notes shared by link (unlisted). Both render publicly at
  `/note/<slug>`; maximum indexable surface. (Product owner decision.)
- **Refresh mechanism: ISR** — `export const revalidate = 3600` on the
  sitemap route: regenerated at most hourly on traffic, so a newly published
  note appears within ~an hour, no redeploy. Build-time-static was rejected
  (stale between Netlify deploys); a publish webhook was rejected (needs an
  authenticated endpoint for marginal gain over hourly).
- **QR is a static asset** — generated to `public/app-qr.svg` by a script
  using the `qrcode` package as a devDependency; no runtime dependency for a
  URL that never changes.
- Base URL everywhere: `https://quizliai.com`.

## Design

### Sitemap + robots

- `app/sitemap.ts` — default export returning a `MetadataRoute.Sitemap`:
  static entries (`/`) + one entry per note in the public `notes`
  collection (`loc: https://quizliai.com/note/<slug>`,
  `lastModified: updatedAt ?? createdAt`). Fetch via a new
  `getAllNotesForSitemap()` in `lib/studyGuide.ts` (queries the `notes`
  collection ordered by createdAt, no `listed` filter — reuses the existing
  client SDK, which runs server-side). `export const revalidate = 3600`.
- `app/robots.ts` — allow all; `sitemap: https://quizliai.com/sitemap.xml`.
- Firestore failures degrade to the static entries only (logged).

### Per-note metadata

- `app/note/[slug]/page.tsx` becomes a thin **server component**:
  `generateMetadata({ params })` fetches the guide and returns
  `title: "<guide.title> | QuizliAI"`, `description` (first `tldr` entry,
  fallback a fixed string), `alternatives.canonical`, and
  `openGraph.images` (YouTube maxres thumbnail when `youtubeId` exists).
  The component fetches the guide once and renders the existing client
  component (moved to `app/note/[slug]/GuideClient.tsx`, unchanged) as
  `<GuideClient initialGuide={guide} slug={slug} />`; the client component
  uses the passed guide instead of refetching (removes today's double
  fetch) and keeps its fetch path as the fallback when `initialGuide` is
  null (not-found / error).

### QR code

- `scripts/generate-app-qr.mjs` — `qrcode` (new devDependency) renders the
  App Store URL to `public/app-qr.svg`; committed; rerunnable.
- Hero: a "Get the app" card beside the existing CTA — the QR in a white
  rounded card with the caption "Scan to download on the App Store",
  dark-theme-consistent, whole card links to the App Store URL.
- Footer: a compact QR block next to the existing App Store link, also
  linked.
- Header's existing text link stays.

## Verification

- `npx tsc --noEmit`, per-file eslint, `npm run build`.
- Deployed checks: `curl https://quizliai.com/sitemap.xml` lists notes;
  `/robots.txt` references the sitemap; a note URL's `<title>` is the
  guide's title.
- Owner one-time step (documented in the PR/commit summary): Google Search
  Console — verify `quizliai.com`, submit `https://quizliai.com/sitemap.xml`.

## Out of scope

- Structured data / JSON-LD beyond basics (follow-up if desired).
- Play Store / Android QR.
- Sitemap ping-on-publish.
