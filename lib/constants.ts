// Single source of truth for the iOS App Store listing URL.
// NOTE: scripts/generate-app-qr.mjs keeps its own copy (.mjs can't import
// .ts) — if this URL ever changes, update both and rerun the script to
// regenerate public/app-qr.svg.
export const APP_STORE_URL = "https://apps.apple.com/us/app/quizliai/id6751740981";
