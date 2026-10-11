import type { Question } from "../contract.js";

/** OpusClip does not document a customPrompt length limit; keep prompts short and focused. */
export const MAX_PROMPT_CHARS = 900;

/**
 * Translates prioritized audience questions into a ClipAnything prompt. It asks
 * for matching moments only. It is guidance for clip selection, not proof the
 * video answers anything.
 */
export function buildClipAnythingPrompt(questions: Pick<Question, "question" | "priority">[], creatorGoal: string | null): string {
  const qs = [...questions].sort((a, b) => a.priority - b.priority);
  const head = "Find moments where the speaker directly addresses one of these viewer questions:";
  const tail =
    "Choose self-contained segments where the answer or explanation is actually spoken or shown. " +
    "Skip a question if the video never addresses it; do not force clips for it.";
  const goal = creatorGoal ? ` Creator goal: ${oneLine(creatorGoal, 160)}.` : "";
  const budget = MAX_PROMPT_CHARS - head.length - tail.length - goal.length - 8;
  const perQuestion = Math.max(60, Math.floor(budget / Math.max(qs.length, 1)) - 6);
  const list = qs.map((q, i) => `${i + 1}) ${oneLine(q.question, perQuestion)}`).join(" ");
  return `${head} ${list}${goal} ${tail}`.slice(0, MAX_PROMPT_CHARS);
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
