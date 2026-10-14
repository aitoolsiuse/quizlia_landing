// In-app App Store QR nudge state (spec: 2026-10-14-inapp-qr-design).
// Browser-local, keyed per profile id — no server state.

export const SHOW_APP_QR_EVENT = "quizli-show-app-qr";

const key = (pid: number | string, suffix: string) => `qr${suffix}_${pid}`;

export function isOptedOut(profileId: number | string): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(key(profileId, "OptOut")) === "1";
}

export function optOutQr(profileId: number | string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key(profileId, "OptOut"), "1");
}

// Returns true exactly once per profile (check-and-set) — the "first
// sign-in" showing (first time the app mounts for them on this browser).
export function shouldShowSigninQr(profileId: number | string): boolean {
  if (typeof window === "undefined") return false;
  const k = key(profileId, "SigninShown");
  if (localStorage.getItem(k) === "1") return false;
  localStorage.setItem(k, "1");
  return true;
}

// Increments the generation counter; returns the new count when it is a
// trigger (1 or a multiple of 5), null otherwise. Always counts — even when
// opted out — so the cadence stays truthful if the user un-opts-out later.
export function bumpGenerationCount(profileId: number | string): number | null {
  if (typeof window === "undefined") return null;
  const k = key(profileId, "GenCount");
  let count = 0;
  try {
    count = parseInt(localStorage.getItem(k) || "0", 10) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  localStorage.setItem(k, String(count));
  return count === 1 || count % 5 === 0 ? count : null;
}
