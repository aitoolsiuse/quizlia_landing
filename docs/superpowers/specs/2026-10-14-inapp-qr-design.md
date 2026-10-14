# In-App App Store QR Nudge — Design Spec

Date: 2026-10-14
Status: Approved

## Problem

The App Store QR exists only on the landing page. Web-app users — the people
most engaged — are never nudged toward the iOS app after entering the app.

## Goals

Show a floating App Store QR card inside the web app:
1. once when the user first signs in (first time the app mounts for their
   profile on a browser),
2. when they generate their first note,
3. on every 5th generation (5, 10, 15…).

An ✕ hides the card for the moment (it returns at the next trigger); a
separate "Don't show again" opts out permanently. (Product owner decisions.)

## Design

### State + triggers — `lib/appPromo.ts` (new)

All localStorage, keyed per profile id (the app's convention):

- `bumpGenerationCount(profileId): number | null` — increments
  `genCount_<pid>` and returns the new count when it equals `1` or is a
  multiple of `5`; returns null otherwise (not a trigger).
- `shouldShowSigninQr(profileId): boolean` — returns true exactly once per
  profile (checks-and-sets `qrSigninShown_<pid>`).
- `isOptedOut(profileId): boolean` / `optOutQr(profileId): void` — permanent
  kill switch (`qrOptOut_<pid>` = "1").
- Trigger delivery: `window.dispatchEvent(new CustomEvent("quizli-show-app-qr"))`.

### The card — `components/app/AppPromoQRCard.tsx` (new, "use client")

- Mounted once in `app/note/layout.tsx` (present on every app page).
- Fixed `bottom-4 right-4`, `z-40` (below modals at z-50), white rounded-2xl
  card on the dark-friendly border pattern; QR via
  `<Image src="/app-qr.svg" unoptimized>` at ~112px (scannable); caption
  "QuizliAI on your phone" + "Scan to download on the App Store"; the whole
  card is an `<a>` to `APP_STORE_URL` (desktop scans, mobile taps).
- Controls: ✕ (top-right) hides the card until the next trigger;
  "Don't show again" (text button) calls `optOutQr` and hides.
- On mount: reads `currentProfile` from localStorage; if `isOptedOut` →
  render nothing (and stay inert); else if `shouldShowSigninQr` → show once.
- Subscribes to the `quizli-show-app-qr` event; ignores it when opted out.

### Wiring — `hooks/useGenerateContent.ts`

In the success path (immediately after `incrementUsage(profile.id)`):

```ts
const triggerCount = bumpGenerationCount(profile.id);
if (triggerCount !== null && !isOptedOut(profile.id)) {
  window.dispatchEvent(new CustomEvent("quizli-show-app-qr"));
}
```

(The counter always counts; only the card display respects the opt-out, so
un-opting later resumes at the true count.)

## Error handling

Missing/corrupt localStorage values are treated as unset (defaults: count 0,
not shown, not opted out). The card never blocks or errors the app — worst
case it doesn't render.

## Verification

`tsc` / per-file eslint / `npm run build`; owner hand pass:
fresh profile → card on first app visit; generation 1 → card; 2-4 → nothing;
5 → card; ✕ → returns at 10; "Don't show again" → never again (including
sign-in and generation triggers); card tap → App Store.

## Out of scope

- Server-side (account-level) opt-out or counters — browser-local only.
- Frequency capping beyond the 5-generation cadence.
- Android/Play.
