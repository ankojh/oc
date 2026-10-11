// Deterministic comment hygiene that runs before any model sees the data:
// duplicate removal, obvious-spam removal and question detection. Nothing here
// edits comment text; it only decides which retrieved comments are eligible.
import type { RetrievedComment } from "../youtube/types.js";

export interface CandidateComment extends RetrievedComment {
  /** Heuristic hint for the analyzer; the analyzer still decides. */
  looksLikeQuestion: boolean;
  looksLikeRequest: boolean;
}

export interface PrefilterStats {
  retrieved: number;
  uniqueRetrieved: number;
  duplicatesRemoved: number;
  spamRemoved: number;
  emptyRemoved: number;
  eligible: number;
  questionLike: number;
  requestLike: number;
}

const SPAM_PATTERNS: RegExp[] = [
  /\bsub(scribe)?\s*(4|for)\s*sub\b/i,
  /\b(check|visit|watch)\s+(out\s+)?my\s+(channel|page|profile|video)/i,
  /\b(whats\s?app|telegram|t\.me\/|wa\.me\/)/i,
  /\b(crypto|bitcoin|forex|binance|usdt)\b.*\b(invest|profit|earn|signal|returns?)\b/i,
  /\b(earn|make)\s+\$?\d+[k]?\s*(per|a|\/)\s*(day|week|hour)/i,
  /\b(onlyfans|nudes?|xxx)\b/i,
  /\bfree\s+(v-?bucks|robux|gift\s*cards?)\b/i,
  /\b(dm|message)\s+me\s+(for|on)\b/i,
];

const QUESTION_START =
  /^(how|what|why|when|where|which|who|whom|whose|is|are|was|were|do|does|did|can|could|would|will|should|shall|have|has|any|anyone)\b/i;
const REQUEST_PATTERNS: RegExp[] = [
  /\b(please|pls|plz)\s+(make|do|cover|explain|show|talk|film|review|share)/i,
  /\b(would|i'?d)\s+love\s+(to\s+see|a\s+video|if\s+you)/i,
  /\b(can|could)\s+you\s+(make|do|cover|explain|show)/i,
  /\bmake\s+a\s+(video|tutorial|part\s*2)\b/i,
  /\bi\s+wish\s+you\s+(had|would|could)\b/i,
  /\b(next|future)\s+video\s+(on|about|idea)\b/i,
  /\bpart\s*2\b/i,
];

/** Lowercased, accent-folded, punctuation- and whitespace-collapsed form used only for duplicate detection. */
export function normalizeForDedupe(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function isObviousSpam(text: string): boolean {
  if (SPAM_PATTERNS.some((p) => p.test(text))) return true;
  const links = text.match(/https?:\/\/\S+/g) ?? [];
  const words = normalizeForDedupe(text).split(" ").filter(Boolean);
  if (links.length >= 2) return true;
  if (links.length >= 1 && words.length <= 6) return true;
  if (/(.)\1{14,}/u.test(text)) return true; // long runs of one character
  return false;
}

export function looksLikeQuestion(text: string): boolean {
  if (/\?/.test(text)) return true;
  return text.split(/[.!\n]+/).some((s) => QUESTION_START.test(s.trim()) && s.trim().split(/\s+/).length >= 4);
}

export function looksLikeRequest(text: string): boolean {
  return REQUEST_PATTERNS.some((p) => p.test(text));
}

export function prefilterComments(all: RetrievedComment[]): { candidates: CandidateComment[]; stats: PrefilterStats } {
  const seenIds = new Set<string>();
  const seenText = new Set<string>();
  let duplicates = 0;
  let spam = 0;
  let empty = 0;
  const candidates: CandidateComment[] = [];
  for (const c of all) {
    // The same comment ID can be fetched twice; that is not a second signal.
    if (seenIds.has(c.commentId)) {
      duplicates++;
      continue;
    }
    seenIds.add(c.commentId);
    const norm = normalizeForDedupe(c.text);
    if (!norm) {
      empty++;
      continue;
    }
    // Identical text (copy-paste, same author on several videos) counts once.
    if (seenText.has(norm)) {
      duplicates++;
      continue;
    }
    seenText.add(norm);
    if (isObviousSpam(c.text)) {
      spam++;
      continue;
    }
    candidates.push({ ...c, looksLikeQuestion: looksLikeQuestion(c.text), looksLikeRequest: looksLikeRequest(c.text) });
  }
  return {
    candidates,
    stats: {
      retrieved: all.length,
      uniqueRetrieved: seenIds.size,
      duplicatesRemoved: duplicates,
      spamRemoved: spam,
      emptyRemoved: empty,
      eligible: candidates.length,
      questionLike: candidates.filter((c) => c.looksLikeQuestion).length,
      requestLike: candidates.filter((c) => c.looksLikeRequest).length,
    },
  };
}
