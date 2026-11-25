// Ported from the frontend's src/lib/search.ts. The frontend wins: keep behaviour identical.

/** Lowercase, strip Arabic diacritics and unify letter variants so "أحمد" matches "احمد". */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "") // diacritics, superscript alef, tatweel
    .replace(/[أإآٱ]/g, "ا") // أ إ آ ٱ -> ا
    .replace(/ى/g, "ي") // ى -> ي
    .replace(/ة/g, "ه") // ة -> ه
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const tokens = (q: string) => normalize(q).split(" ").filter(Boolean);

/** Score a haystack against query tokens: every token must match; word-start matches rank higher. */
export function scoreText(haystack: string, qTokens: string[]): number {
  if (qTokens.length === 0) return 0;
  let score = 0;
  for (const t of qTokens) {
    const idx = haystack.indexOf(t);
    if (idx === -1) return 0;
    score += idx === 0 || haystack[idx - 1] === " " ? 3 : 1;
  }
  return score;
}
