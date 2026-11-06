// The participant's unsent self-ratings, kept in sessionStorage so a reload does not lose them. One fixed key: the page cannot know
// which credential it is, so the draft is cleared when a link is entered, on a save, on a refused link and on `closed`. Storage may be
// blocked or full: every call is in try/catch and the form works without it.

export type DraftLevel = 1 | 2 | 3 | 4 | "na" | null;
/** `null` is untouched (omitted on submit); `"na"` is Not observed. */
export type Draft = { ratings: Record<string, { level: DraftLevel; note: string }> };

const KEY = "scenecoach-report-draft";
const isLevel = (v: unknown): v is DraftLevel => v === null || v === "na" || v === 1 || v === 2 || v === 3 || v === 4;

export function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || typeof (v as { ratings?: unknown }).ratings !== "object") return null;
    const src = (v as { ratings: Record<string, unknown> }).ratings;
    if (src === null || Array.isArray(src)) return null;
    const ratings: Draft["ratings"] = {};
    for (const [id, r] of Object.entries(src)) {
      if (typeof r !== "object" || r === null) return null;
      const { level, note } = r as { level?: unknown; note?: unknown };
      if (!isLevel(level) || typeof note !== "string") return null;
      ratings[id] = { level, note };
    }
    return { ratings };
  } catch {
    return null;
  }
}

export function saveDraft(d: Draft): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage unavailable: the form still works */ }
}

export function clearDraft(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
