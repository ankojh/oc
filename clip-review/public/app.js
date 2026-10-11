// Review page. All handoff content is untrusted: render with textContent only,
// and allow only http(s) URLs in links and media.
const $ = (id) => document.getElementById(id);
let handoff = null;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "href" || k === "src") { const u = safeUrl(v); if (u) el.setAttribute(k, u); }
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
function safeUrl(u) {
  try { const x = new URL(u, location.href); return ["http:", "https:"].includes(x.protocol) ? x.href : null; } catch { return null; }
}
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const VERDICT_TEXT = {
  direct: "Answers the question",
  partial: "Partially answers",
  related_only: "Related topic, no answer",
  no_match: "No useful connection",
  unverifiable: "Cannot verify",
};
const ORDER = { direct: 0, partial: 1, related_only: 2, unverifiable: 3, no_match: 4 };

async function loadFixtures() {
  const list = await (await fetch("/fixtures")).json();
  for (const f of list) $("fixture").append(h("option", { value: f }, f));
}
$("fixture").onchange = async (e) => {
  if (!e.target.value) return;
  handoff = await (await fetch(`/fixtures/${e.target.value}`)).json();
  $("file").value = "";
  ready(`Loaded fixture ${e.target.value}`);
};
$("file").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    handoff = JSON.parse(await f.text());
    $("fixture").value = "";
    ready(`Loaded ${f.name}`);
  } catch (err) {
    handoff = null;
    showStatus([h("div", { class: "banner error" }, `That file is not valid JSON: ${err.message}`)]);
  }
};
function ready(msg) { $("loaded").textContent = msg; $("go").disabled = false; }
function showStatus(nodes) { $("status").replaceChildren(...nodes); }

$("go").onclick = async () => {
  $("out").replaceChildren();
  const q = new URLSearchParams();
  if ($("rerun").checked) q.set("rerun", "true");
  if ($("backend").value) q.set("backend", $("backend").value);
  const res = await fetch(`/reviews?${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(handoff) });
  const body = await res.json();
  if (!body.reviewId) return showStatus([h("div", { class: "banner error" }, body.error || "Request failed", body.hint ? ` — ${body.hint}` : "")]);
  history.replaceState(null, "", `#${body.reviewId}`);
  poll(body.reviewId, body.reused);
};

async function poll(id, reused) {
  for (;;) {
    const r = await (await fetch(`/reviews/${id}`)).json();
    showStatus([
      h("div", { class: "panel" },
        h("div", { class: "row" }, h("strong", {}, `Review ${id}`), h("span", { class: "muted" }, r.status), reused ? h("span", { class: "muted" }, "· reused prior review for identical input (tick “force rerun” to redo)") : null),
        h("ul", { class: "lim" }, r.progress.map((p) => h("li", {}, `${new Date(p.at).toLocaleTimeString()} — ${p.step}`))),
        r.errors.length ? h("div", { class: "banner error" }, h("div", {}, "This review could not be completed:"),
          h("ul", {}, r.errors.map((e) => h("li", {}, h("code", {}, e.path), ` ${e.message}`, e.hint ? h("div", { class: "muted" }, `Fix: ${e.hint}`) : null)))) : null,
      ),
    ]);
    if (r.status === "succeeded") {
      if (!handoff) handoff = await (await fetch(`/reviews/${id}/input`)).json();
      return render(r);
    }
    if (r.status === "failed") return;
    await new Promise((res) => setTimeout(res, 800));
  }
}

function render(r) {
  const report = r.report;
  const input = handoff;
  const research = input?.research;
  const qById = new Map((research?.questions ?? []).map((q) => [q.id, q]));
  const evById = new Map((research?.evidence ?? []).map((e) => [e.id, e]));
  const clipById = new Map((input?.clips ?? []).map((c) => [c.id, c]));
  const srcById = new Map((input?.sourceTranscript?.segments ?? []).map((s) => [s.id, s]));
  const checks = new Map((r.audit?.questionChecks ?? []).map((c) => [c.questionId, c]));
  const out = [];

  if (report.mode === "fixture")
    out.push(h("div", { class: "banner fixture" }, "FIXTURE DATA — synthetic audience comments and clips, not collected from YouTube or OpusClip."));
  const rv = r.reviewer || {};
  out.push(h("div", { class: rv.backend === "codex" ? "banner live" : "banner fixture" },
    rv.backend === "codex" ? `Reviewed live by Codex (${rv.model}, effort ${rv.reasoningEffort}, ${rv.promptVersion})`
      : rv.backend === "fixture" ? `REPLAYED REVIEWER RESPONSE — ${rv.fixtureResponse} (${rv.promptVersion}). Not a live model run.`
      : `Reviewer model not invoked: ${rv.reason || "n/a"}`));
  out.push(h("div", { class: "row" },
    h("span", {}, `Status: `, h("strong", {}, report.status)),
    research ? h("span", { class: "muted" }, `Video: ${research.video.title}`) : null,
    h("a", { href: `/reviews/${r.reviewId}/report.json` }, "Download review report (JSON)")));

  // Recommendations
  out.push(h("h2", {}, "Recommended clips"));
  if (!report.recommendations.length) out.push(h("p", { class: "muted" }, "No clip is recommended: none verifiably answers a supported audience question."));
  for (const rec of report.recommendations) {
    const c = clipById.get(rec.clipId);
    out.push(h("div", { class: "panel rec" }, h("span", { class: "rank" }, `#${rec.rank}`),
      h("div", {}, h("strong", {}, c?.title ?? rec.clipId), h("div", {}, rec.reason),
        h("div", { class: "muted" }, "Answers: ", rec.questionIds.map((q) => qById.get(q)?.question ?? q).join(" · ")))));
  }

  // Per question
  out.push(h("h2", {}, "Audience questions"));
  for (const q of research?.questions ?? []) {
    const ms = report.matches.filter((m) => m.questionId === q.id).sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);
    const strong = ms.filter((m) => m.verdict === "direct" || m.verdict === "partial");
    // Clips that don't answer but carry a context warning stay visible: the warning is the finding.
    const flagged = ms.filter((m) => !strong.includes(m) && m.contextWarnings.length);
    const other = ms.filter((m) => !strong.includes(m) && !flagged.includes(m));
    const check = checks.get(q.id);
    const card = h("div", { class: "panel" },
      h("div", { class: "row" }, h("span", { class: "q" }, q.question), h("span", { class: "pill kind" }, q.kind),
        check && check.support !== "supported" ? h("span", { class: "pill v-unverifiable" }, `comments: ${check.support}`) : null),
      check && check.support !== "supported" ? h("div", { class: "warn" }, `Research check: ${check.explanation}`) : null,
      q.kind === "inferred" ? h("div", { class: "muted" }, "Inferred by research from these comments — not asked verbatim.") : null,
      h("div", { class: "muted", style: "margin-top:8px" }, "Found in these comments:"),
      ...q.evidenceIds.map((id) => {
        const e = evById.get(id);
        if (!e) return h("blockquote", {}, h("em", {}, `Missing evidence ${id} (cited by research but not in the handoff)`));
        return h("blockquote", {}, `“${e.quote}” `, h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, "view comment"));
      }),
      strong.length ? strong.map((m) => matchView(m, clipById, srcById, false)) : h("p", { class: "muted" }, "No generated clip answers this question."),
      flagged.map((m) => matchView(m, clipById, srcById, false)),
    );
    const un = report.unansweredQuestions.find((u) => u.questionId === q.id);
    if (un) card.append(h("div", { class: "warn" }, h("strong", {}, un.status.replaceAll("_", " ")), ` — ${un.explanation}`));
    if (other.length) card.append(h("details", {}, h("summary", {}, `${other.length} other clip(s) checked`), other.map((m) => matchView(m, clipById, srcById, true))));
    out.push(card);
  }

  out.push(h("h2", {}, "Limitations"));
  out.push(h("ul", { class: "lim panel" }, report.limitations.map((l) => h("li", {}, l))));
  if (r.audit?.corrections?.length)
    out.push(h("details", { class: "panel" }, h("summary", {}, `${r.audit.corrections.length} reviewer claim(s) corrected by deterministic checks`),
      h("ul", { class: "lim" }, r.audit.corrections.map((c) => h("li", {}, c)))));
  $("out").replaceChildren(...out);
}

function matchView(m, clipById, srcById, compact) {
  const c = clipById.get(m.clipId);
  const answers = m.verdict === "direct" || m.verdict === "partial";
  const media = c?.previewUrl && safeUrl(c.previewUrl)
    ? h("video", { src: c.previewUrl, controls: "", preload: "metadata", playsinline: "" })
    : h("div", { class: "novideo" }, "Preview unavailable for this clip");
  const body = h("div", {},
    h("div", { class: "row" }, h("span", { class: `pill v-${m.verdict}` }, VERDICT_TEXT[m.verdict]), h("strong", {}, c?.title ?? m.clipId), h("code", {}, m.clipId)),
    answers ? h("div", { class: "muted", style: "margin-top:4px" }, m.verdict === "direct" ? "This clip answers a question found in the comments above." : "This clip answers part of a question found in the comments above.") : null,
    h("p", {}, m.explanation),
    ...m.answerPassages.map((p) => h("blockquote", { class: answers ? "answer" : "" }, `“${p.quote}”`, h("div", { class: "muted" }, `source ${fmt(p.sourceStartMs)}–${fmt(p.sourceEndMs)} · segment ${p.clipTranscriptSegmentId}`))),
    ...m.contextWarnings.map((w) => h("div", { class: "warn" }, h("strong", {}, "Context warning: "), w.explanation,
      ...w.sourceSegmentIds.map((id) => { const s = srcById.get(id); return h("blockquote", { class: "context" }, s ? `“${s.text}”` : id, s ? h("div", { class: "muted" }, `omitted source ${fmt(s.startMs)}–${fmt(s.endMs)} · ${id}`) : null); }))),
    m.limitations.length ? h("ul", { class: "lim" }, m.limitations.map((l) => h("li", {}, l))) : null,
    !compact ? (c?.exportUrl && safeUrl(c.exportUrl) ? h("a", { href: c.exportUrl, target: "_blank", rel: "noopener noreferrer" }, "Open existing export") : h("div", { class: "muted" }, "Export unavailable for this clip.")) : null,
  );
  return compact ? h("div", { class: "match compact" }, body) : h("div", { class: "match" }, media, body);
}

loadFixtures();
// Reopen a stored review via /#<reviewId>.
if (location.hash.length > 1) poll(location.hash.slice(1), false);
