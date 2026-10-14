# SEO rollout checklist

Code side (shipped with `feature/seo-qr`):

- `/sitemap.xml` — every accessible public note + `/`, regenerated hourly
  (ISR) — new publishes appear within ~an hour of traffic, no redeploy.
- `/robots.txt` — allow all, points to the sitemap.
- `/note/<slug>` pages carry per-note `<title>`, description, canonical URL,
  and OG image (YouTube thumbnail when present).
- App Store QR on the landing hero + footer (`scripts/generate-app-qr.mjs`
  regenerates `public/app-qr.svg` if the App Store URL ever changes).

One-time owner steps (Google Search Console):

1. https://search.google.com/search-console → Add property → Domain →
   `quizliai.com` → verify via the DNS TXT record (your registrar/DNS).
2. Sitemaps → Add a new sitemap → `sitemap.xml` → Submit.
3. URL Inspection → request indexing for `/` and one or two note URLs to
   seed the first crawl.
4. Re-check in a few days: Coverage should climb as notes get indexed.
