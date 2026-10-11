/** Normalization used for quote matching: whitespace, case, curly quotes, dashes, ellipses. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when `quote` is a contiguous (normalized) substring of `text`. */
export function quoteMatches(text: string, quote: string): boolean {
  const q = normalizeText(quote).replace(/^["']|["']$/g, "").trim();
  return q.length > 0 && normalizeText(text).includes(q);
}
