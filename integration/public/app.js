// Integration UI. All text from comments, transcripts and reviewers is untrusted:
// it is only ever inserted with textContent, never as HTML.
"use strict";

const FIXTURE_DEMO = { videoUrl: "https://www.youtube.com/watch?v=FXdemo00001", creatorGoal: "Turn recurring viewer questions into Shorts" };
const TERMINAL = new Set(["complete", "insufficient_evidence", "unverifiable", "failed"]);
const $ = (sel) => document.querySelector(sel);

let current = null; // integration id shown
let lastUpdatedAt = null;
let pollTimer = null;
const ui = { creditsChecked: false, forceChecks: [false, false], busy: false };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "href") el.setAttribute("href", /^https?:\/\//.test(v) ? v : "#");
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const ts = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error || {};
    const err = new Error(e.message || `HTTP ${res.status}`);
    err.code = e.code;
    err.action = e.action;
    throw err;
  }
  return json;
}

// ------------------------------------------------------------------ form

function modeHelp() {
  const mode = new FormData($("#start")).get("mode");
  $("#mode-help").textContent =
    mode === "fixture"
      ? "Fixture mode uses synthetic comments, a fixture OpusClip project and an authored reviewer judgment bound to the fixture demo. Other URLs or goals have no fixture data."
      : "Live mode reads real YouTube comments, runs Codex, and Generate consumes OpusClip credits after you confirm.";
}

$("#start").addEventListener("change", modeHelp);
$("#fixture-demo").addEventListener("click", () => {
  const f = $("#start");
  f.videoUrl.value = FIXTURE_DEMO.videoUrl;
  f.creatorGoal.value = FIXTURE_DEMO.creatorGoal;
  f.querySelector('input[value="fixture"]').checked = true;
  modeHelp();
});
$("#start").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const err = $("#start-error");
  err.hidden = true;
  const btn = ev.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const out = await api("POST", "/api/integrations", { videoUrl: f.get("videoUrl"), creatorGoal: f.get("creatorGoal") || null, mode: f.get("mode") });
    show(out.integrationId);
    loadRecent();
  } catch (e) {
    err.textContent = `${e.message}${e.action ? ` — ${e.action}` : ""}`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

async function loadServices() {
  try {
    const s = await api("GET", "/api/services");
    const el = $("#services");
    el.replaceChildren(
      h("div", {}, `Research service: ${s.research.ok ? "up" : `DOWN (${s.research.error})`}`),
      s.research.ok ? h("div", {}, `Live readiness: YouTube key ${s.research.live.youtubeApiKey ? "set" : "missing"}, OpusClip via ${s.research.live.opusTransport}${s.research.live.opusTransport === "rest" ? ` (key ${s.research.live.opusApiKey ? "set" : "missing"})` : ""}`) : null,
      h("div", {}, `Review service: ${s.review.ok ? `up (${s.review.reviewerVersion})` : `DOWN (${s.review.error})`}`),
    );
  } catch {
    /* ignore */
  }
}

async function loadRecent() {
  const list = await api("GET", "/api/integrations").catch(() => []);
  $("#recent").replaceChildren(
    ...list.slice(0, 15).map((r) =>
      h("li", {}, h("a", { href: `#${r.integrationId}`, onclick: (e) => (e.preventDefault(), show(r.integrationId)) }, `${r.mode === "fixture" ? "[fixture] " : ""}${r.videoUrl.replace(/^https:\/\/(www\.)?/, "")}`), h("div", { class: "muted" }, `${r.status}${r.failedStage ? ` (${r.failedStage})` : ""} · ${new Date(r.createdAt).toLocaleString()}`)),
    ),
  );
}

// ------------------------------------------------------------------ view

function show(id) {
  current = id;
  lastUpdatedAt = null;
  ui.creditsChecked = false;
  ui.forceChecks = [false, false];
  if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  refresh();
}

async function refresh() {
  clearTimeout(pollTimer);
  if (!current) return;
  try {
    const v = await api("GET", `/api/integrations/${encodeURIComponent(current)}`);
    if (v.updatedAt !== lastUpdatedAt && !ui.busy) {
      lastUpdatedAt = v.updatedAt;
      render(v);
    }
    if (!TERMINAL.has(v.status)) pollTimer = setTimeout(refresh, 1500);
    else loadRecent();
  } catch (e) {
    $("#view").replaceChildren(h("div", { class: "card error" }, e.message));
  }
}

async function act(path, body, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  ui.busy = true;
  try {
    await api("POST", `/api/integrations/${encodeURIComponent(current)}/${path}`, body || {});
  } catch (e) {
    alert(`${e.code ? `${e.code}: ` : ""}${e.message}${e.action ? `\n\n${e.action}` : ""}`);
  } finally {
    ui.busy = false;
    lastUpdatedAt = null;
    refresh();
  }
}

function banner(v) {
  const b = $("#mode-banner");
  b.hidden = false;
  b.className = v.mode === "fixture" ? "banner" : "banner live";
  b.textContent = v.mode === "fixture" ? v.modeLabel : "LIVE — real YouTube comments, OpusClip project and Codex review";
}

function stepper(v) {
  const order = ["research", "generation", "handoff", "review"];
  const reached = { researching: 0, research_ready: 1, insufficient_evidence: 0, generating: 1, needs_reconciliation: 1, reviewing: 3, complete: 4, unverifiable: 4 }[v.status];
  const idx = v.status === "failed" ? order.indexOf(v.failedStage) : reached;
  const label = { research: "Research", generation: "Generate clips", handoff: "Handoff", review: "Review" };
  return h(
    "div",
    { class: "steps" },
    order.map((s, i) => h("span", { class: `step ${v.status === "failed" && i === idx ? "failed" : i < idx || (i === idx && TERMINAL.has(v.status)) ? "done" : i === idx ? "active" : ""}` }, label[s])),
  );
}

function errorBox(v) {
  if (!v.error) return null;
  return h(
    "div",
    { class: "errbox" },
    h("div", {}, h("strong", {}, `${v.failedStage} failed: ${v.error.code}`)),
    h("div", {}, v.error.message),
    v.error.action ? h("div", { class: "muted" }, `What to do: ${v.error.action}`) : null,
    h(
      "div",
      { class: "row", style: "margin-top:8px" },
      v.actions.retryReview ? h("button", { onclick: () => act("retry-review") }, "Retry review") : null,
      v.actions.retryHandoff ? h("button", { onclick: () => act("retry-handoff") }, "Retry handoff") : null,
      v.actions.resumePolling ? h("button", { onclick: () => act("resume-polling") }, "Resume polling the existing project") : null,
      v.failedStage === "research" ? h("span", { class: "muted small" }, "Research is free to repeat: start again from the form.") : null,
    ),
  );
}

function header(v) {
  return h(
    "div",
    { class: "card" },
    h("div", { class: "status" }, v.statusText),
    stepper(v),
    h(
      "div",
      { class: "small muted" },
      `Integration ${v.integrationId} · research run ${v.research.runId ?? "—"}`,
      v.generation.projectId ? ` · OpusClip project ${v.generation.projectId}` : "",
      v.review.reviewId ? ` · review ${v.review.reviewId}` : "",
    ),
    h("div", { class: "small" }, link(v.input.videoUrl, v.input.videoUrl), v.input.creatorGoal ? ` · goal: ${v.input.creatorGoal}` : ""),
    errorBox(v),
  );
}

function researchCard(v) {
  const c = v.research.coverage;
  if (!c && v.status === "researching")
    return h("div", { class: "card" }, h("h2", {}, "Research"), h("ul", { class: "plain small" }, v.research.progress.slice(-8).map((p) => h("li", {}, p.message))));
  if (!c) return null;
  return h(
    "div",
    { class: "card" },
    h("h2", {}, `Research: ${v.research.video?.title ?? ""}`),
    h("div", { class: "small" }, `${c.commentCount} comments sampled from ${c.videoIds.length} video(s), fetched ${new Date(c.fetchedAt).toLocaleString()}.`),
    h("details", {}, h("summary", {}, "Sampling method and limits"), h("p", { class: "small" }, c.samplingMethod), h("ul", { class: "plain small" }, c.limitations.map((l) => h("li", {}, l)))),
    v.status === "insufficient_evidence" ? h("div", { class: "warnbox" }, "No audience question had enough supporting comments. Nothing was generated and no credits were used.") : null,
  );
}

function generateCard(v) {
  if (!v.actions.generate && v.status !== "needs_reconciliation") return null;
  if (v.actions.generate) {
    const live = v.mode === "live";
    const btn = h("button", { disabled: live && !ui.creditsChecked }, "Generate clips");
    btn.addEventListener("click", () => {
      btn.disabled = true;
      act("generate", { confirmCredits: true });
    });
    return h(
      "div",
      { class: "card" },
      h("h2", {}, "Generate clips"),
      h("p", { class: "small" }, v.generation.creditNotice ?? (live ? "Generate submits ONE OpusClip project and consumes credits." : "Fixture mode: no OpusClip account, no credits.")),
      v.research.generationBrief ? h("details", {}, h("summary", {}, "Prompt sent to OpusClip"), h("pre", {}, v.research.generationBrief.customPrompt)) : null,
      live
        ? h(
            "label",
            { class: "inline" },
            h("input", { type: "checkbox", checked: ui.creditsChecked, onchange: (e) => ((ui.creditsChecked = e.target.checked), (btn.disabled = !e.target.checked)) }),
            "I understand this submits one OpusClip project and uses my OpusClip credits.",
          )
        : null,
      h("div", { class: "row" }, btn),
    );
  }
  // Reconciliation: the submission outcome is unknown.
  const r = v.generation.reconciliation;
  const forceBtn = h("button", { class: "danger", disabled: !(ui.forceChecks[0] && ui.forceChecks[1]) }, "Submit a NEW paid project");
  const check = (i) => h("input", { type: "checkbox", checked: ui.forceChecks[i], onchange: (e) => ((ui.forceChecks[i] = e.target.checked), (forceBtn.disabled = !(ui.forceChecks[0] && ui.forceChecks[1]))) });
  forceBtn.addEventListener("click", () => act("force-new-project", { confirmCredits: true, confirmNewProject: true }));
  return h(
    "div",
    { class: "card" },
    h("h2", {}, "Submission outcome uncertain"),
    h("p", { class: "small" }, v.generation.events.at(-1)?.message ?? ""),
    h("p", { class: "small" }, r?.note ?? "Reconcile to look for the project in your OpusClip account."),
    r?.candidates?.length
      ? h(
          "table",
          {},
          h("tr", {}, h("th", {}, "Project"), h("th", {}, "Created"), h("th", {}, "Title"), h("th", {}, "")),
          r.candidates.map((c) => h("tr", {}, h("td", {}, c.projectId), h("td", {}, c.createdAt ?? "?"), h("td", {}, c.title ?? "?", c.correlated ? " (matches this run)" : ""), h("td", {}, h("button", { class: "secondary", onclick: () => act("adopt-project", { projectId: c.projectId }) }, "Use this project")))),
        )
      : null,
    h("div", { class: "row", style: "margin-top:8px" }, h("button", { onclick: () => act("reconcile") }, "Check OpusClip again")),
    h("p", { class: "small muted" }, "Only projects listed above for this video and bounded submit window may be adopted; never guess a project ID."),
    h(
      "details",
      {},
      h("summary", {}, "Only if you are sure no project was created"),
      h("label", { class: "inline" }, check(0), "I checked the OpusClip dashboard and no project exists for this request."),
      h("label", { class: "inline" }, check(1), "I accept that this submits a new project and consumes credits again."),
      forceBtn,
    ),
  );
}

function progressCard(v) {
  if (!["generating", "reviewing"].includes(v.status)) return null;
  const lines = v.status === "generating" ? v.generation.events.slice(-8).map((e) => e.message) : v.review.progress.slice(-8).map((p) => p.step);
  return h(
    "div",
    { class: "card" },
    h("h2", {}, v.status === "generating" ? `Generating in OpusClip${v.generation.stage ? ` — ${v.generation.stage}` : ""}` : "Reviewing clips"),
    v.status === "generating" ? h("p", { class: "small muted" }, "Generation finishing is not the end: the review agent runs automatically afterwards.") : null,
    h("ul", { class: "plain small" }, lines.map((l) => h("li", {}, l))),
  );
}

function media(v, clip) {
  const fake = !clip.previewUrl || /\.invalid\//.test(clip.previewUrl) || v.mode === "fixture";
  if (fake) return h("div", { class: "media" }, v.mode === "fixture" ? "Fixture clip — no media file exists for synthetic clips." : "No preview available.");
  return h("video", { class: "media", src: clip.previewUrl, controls: true, preload: "metadata", playsinline: true });
}

function passage(v, clip, p, videoEl) {
  const seek = h("button", { class: "secondary" }, `Play in clip at ${ts(p.clipOffsetMs ?? 0)}`);
  const note = h("span", { class: "muted" });
  seek.addEventListener("click", () => {
    if (!(videoEl instanceof HTMLVideoElement)) return;
    const dur = videoEl.duration * 1000;
    if (!Number.isFinite(dur)) return void (note.textContent = " Clip metadata not loaded yet.");
    if (Math.abs(dur - clip.rangesDurationMs) > 1500) {
      seek.disabled = true;
      return void (note.textContent = " Clip length differs from its source ranges (provider edits), so seeking could land on the wrong moment. Use the source link.");
    }
    videoEl.currentTime = p.clipOffsetMs / 1000;
    videoEl.play().catch(() => {});
  });
  const canSeek = p.clipOffsetMs !== null && videoEl instanceof HTMLVideoElement;
  return h(
    "div",
    { class: "passage" },
    h("blockquote", {}, `“${p.quote}”`),
    h("div", { class: "row" }, canSeek ? seek : null, link(p.sourceLink, `Source video at ${ts(p.sourceStartMs)}–${ts(p.sourceEndMs)}`), note),
  );
}

function matchDetail(v, clip, m, videoEl) {
  return h(
    "div",
    {},
    h("div", {}, h("span", { class: `verdict v-${m.verdict}` }, m.verdict.replace("_", " ")), " ", m.explanation),
    m.answerPassages.length ? h("div", {}, h("h3", {}, "Cited answer"), m.answerPassages.map((p) => passage(v, clip, p, videoEl))) : null,
    m.contextWarnings.length
      ? h(
          "div",
          { class: "warnbox" },
          h("strong", {}, "Missing context"),
          m.contextWarnings.map((w) => h("div", {}, w.explanation, h("ul", { class: "plain small" }, w.sourceSegments.map((s) => h("li", {}, s.text ? `“${s.text}” ` : s.id, s.sourceLink ? link(s.sourceLink, `(source ${ts(s.startMs)})`) : null))))),
        )
      : null,
    m.limitations.length ? h("details", {}, h("summary", {}, `Caveats (${m.limitations.length})`), h("ul", { class: "plain small" }, m.limitations.map((l) => h("li", {}, l)))) : null,
  );
}

function questionBlock(v, q) {
  const recs = q.recommendations.map((r) => {
    const videoEl = r.clip ? media(v, r.clip) : h("div", { class: "media" }, "Clip missing");
    return h(
      "div",
      { class: "clip" },
      videoEl,
      h(
        "div",
        {},
        h("div", { class: "qtitle" }, `#${r.rank} ${r.clip?.title || r.clip?.id || ""}`),
        h("p", { class: "small" }, r.reason),
        r.clip ? h("div", { class: "small muted" }, `Source ranges: ${r.clip.sourceRanges.map((x) => `${ts(x.startMs)}–${ts(x.endMs)}`).join(", ")}`, r.clip.exportUrl ? " · " : "", r.clip.exportUrl ? link(r.clip.exportUrl, "HD export") : " · HD export not available") : null,
        r.match ? matchDetail(v, r.clip, r.match, videoEl) : null,
      ),
    );
  });
  return h(
    "div",
    { class: "question" },
    h("div", { class: "qtitle" }, q.question, h("span", { class: "tag" }, q.kind), h("span", { class: "tag" }, `${q.observedCommentCount} comment(s)`)),
    h("div", { class: "small muted" }, q.rationale),
    h("details", { open: true }, h("summary", {}, "What commenters wrote"), q.evidence.map((e) => h("blockquote", {}, `“${e.quote}” `, link(e.url, "comment")))),
    recs.length ? h("div", {}, recs) : null,
    !recs.length && q.unanswered
      ? h("div", { class: "warnbox" }, h("strong", {}, `No recommended clip — ${q.unanswered.status.replaceAll("_", " ")}`), h("div", {}, q.unanswered.explanation))
      : null,
    q.checked.length
      ? h(
          "details",
          {},
          h("summary", {}, `What was checked (${q.checked.length} clip${q.checked.length === 1 ? "" : "s"})`),
          h("table", {}, h("tr", {}, h("th", {}, "Clip"), h("th", {}, "Verdict"), h("th", {}, "Why")), q.checked.map((m) => h("tr", {}, h("td", {}, m.clipTitle || m.clipId), h("td", {}, h("span", { class: `verdict v-${m.verdict}` }, m.verdict.replace("_", " "))), h("td", {}, m.explanation)))),
        )
      : null,
  );
}

function questionsCard(v) {
  if (!v.questions.length) return null;
  const title = v.report ? (v.report.status === "complete" ? "Which clips answer your audience" : v.report.status === "unverifiable" ? "Clips could not be verified" : "Insufficient evidence") : "Audience questions";
  return h(
    "div",
    { class: "card" },
    h("h2", {}, title),
    v.report && v.report.recommendationCount === 0 && v.report.status === "complete" ? h("div", { class: "warnbox" }, "The reviewer did not find a clip that verifiably answers any question.") : null,
    v.questions.map((q) => questionBlock(v, q)),
  );
}

function clipsCard(v) {
  if (!v.clips.length) return null;
  const unverifiable = v.clips.filter((c) => !c.verifiable);
  return h(
    "div",
    { class: "card" },
    h("h2", {}, `All generated clips (${v.clips.length})`),
    h("table", {}, h("tr", {}, h("th", {}, "Clip"), h("th", {}, "Source ranges"), h("th", {}, "Transcript")), v.clips.map((c) => h("tr", {}, h("td", {}, c.title || c.id), h("td", {}, c.sourceRanges.length ? c.sourceRanges.map((x) => `${ts(x.startMs)}–${ts(x.endMs)}`).join(", ") : "unknown"), h("td", {}, c.verifiable ? "available" : "unavailable — unverifiable")))),
    unverifiable.length ? h("p", { class: "small muted" }, `${unverifiable.length} clip(s) without verified source ranges or transcript are kept and shown as unverifiable, never treated as answers.`) : null,
    v.handoff.sourceTranscript ? h("p", { class: "small" }, `Source transcript coverage: ${v.handoff.sourceTranscript.coverage} (${v.handoff.sourceTranscript.segmentCount} segments). `, v.handoff.sourceTranscript.limitations.join(" ")) : null,
  );
}

function limitsCard(v) {
  if (!v.report && !v.handoff.limitations.length) return null;
  const d = v.diagnostics;
  return h(
    "div",
    { class: "card" },
    h("h2", {}, "Limitations"),
    h("ul", { class: "plain small" }, (v.report?.limitations ?? v.handoff.limitations).map((l) => h("li", {}, l))),
    d
      ? h(
          "details",
          {},
          h("summary", {}, "Diagnostics (reviewer, warnings, audit)"),
          h("pre", {}, JSON.stringify({ reviewId: d.reviewId, reviewer: d.reviewer, warnings: d.warnings, audit: d.audit, handoffHash: v.handoff.hash, reviewSubmits: v.review.submitAttempts, reviewHistory: v.review.history, providerSubmitAttempts: v.generation.providerSubmitAttempts }, null, 2)),
        )
      : null,
  );
}

function eventsCard(v) {
  return h("div", { class: "card" }, h("details", {}, h("summary", {}, `Activity log (${v.events.length})`), h("ul", { class: "plain small" }, v.events.map((e) => h("li", {}, `${new Date(e.at).toLocaleTimeString()} [${e.stage}] ${e.message}`)))));
}

function render(v) {
  banner(v);
  $("#view").replaceChildren(...[header(v), researchCard(v), generateCard(v), progressCard(v), questionsCard(v), clipsCard(v), limitsCard(v), eventsCard(v)].filter(Boolean));
}

window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id && id !== current) show(id);
});

modeHelp();
loadServices();
loadRecent();
if (location.hash.length > 1) show(location.hash.slice(1));
