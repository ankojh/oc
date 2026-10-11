// Deterministic analyzer used in fixture mode (no credentials, reproducible
// output). It is deliberately simple: keyword-overlap grouping of comments that
// already look like questions or requests. Live mode uses the Codex agent.
import type { AnalysisResult, ProposedTheme, ResearchAnalyzer, VideoSelection } from "./analyzer.js";
import type { CandidateComment } from "./prefilter.js";

const STOPWORDS = new Set(
  "a an the and or but if then so to of in on at for with from by about into over is are was were be been being do does did can could would will should shall have has had i you he she it we they me my your our their this that these those what which who whom whose how why when where any anyone there here just also really very please pls plz video videos make like get got know think much many more most some thanks thank love great awesome".split(
    " ",
  ),
);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, "")),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** First sentence of a comment that contains a question mark, else the first sentence. */
function questionSentence(text: string): string {
  const sentences = text.split(/(?<=[?.!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  return sentences.find((s) => s.endsWith("?")) ?? sentences[0] ?? text.trim();
}

export class HeuristicResearchAnalyzer implements ResearchAnalyzer {
  readonly name = "heuristic-fixture-analyzer";

  async selectRelatedVideos({ source, candidates, max }: Parameters<ResearchAnalyzer["selectRelatedVideos"]>[0]): Promise<VideoSelection> {
    const sourceKw = keywords(source.title);
    const ranked = candidates
      .map((c, i) => ({ c, i, score: overlap(sourceKw, keywords(c.title)) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, max);
    return { selectedVideoIds: ranked.map((r) => r.c.videoId), reason: "Title keyword overlap with the source video, then recency." };
  }

  async analyze({ comments }: Parameters<ResearchAnalyzer["analyze"]>[0]): Promise<AnalysisResult> {
    const relevant = comments.filter((c) => c.looksLikeQuestion || c.looksLikeRequest);
    const groups: { members: CandidateComment[]; kw: Set<string> }[] = [];
    for (const c of relevant) {
      const kw = keywords(c.text);
      const best = groups
        .map((g) => ({ g, score: overlap(g.kw, kw) }))
        .filter((x) => x.score >= 2)
        .sort((a, b) => b.score - a.score)[0];
      if (best) {
        best.g.members.push(c);
        for (const w of kw) best.g.kw.add(w);
      } else groups.push({ members: [c], kw });
    }
    const themes: ProposedTheme[] = groups
      .sort((a, b) => b.members.length - a.members.length)
      .slice(0, 3)
      .map((g) => {
        const explicit = g.members.filter((m) => m.looksLikeQuestion);
        const kind = explicit.length > 0 ? "explicit" : "inferred";
        const representative = (explicit[0] ?? g.members[0]).text;
        const n = g.members.length;
        return {
          question: kind === "explicit" ? questionSentence(representative) : `Could you cover this viewer request: "${questionSentence(representative).replace(/[.!]+$/, "")}"?`,
          kind,
          commentIds: g.members.map((m) => m.commentId),
          rationale:
            `${n} distinct comment${n === 1 ? "" : "s"} ${kind === "explicit" ? "ask" : "request"} this` +
            (n === 1 ? " — a single signal, not evidence of recurring demand." : ".") +
            (kind === "inferred" ? " Inferred from a request, not asked as a question." : ""),
        };
      });
    return { themes, notes: themes.length === 0 ? "No comments looked like questions or requests." : "Keyword-overlap grouping (fixture analyzer)." };
  }
}
