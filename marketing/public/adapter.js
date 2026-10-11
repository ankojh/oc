export function isYouTubeUrl(value) {
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:')
            return false;
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        const id = host === 'youtu.be' ? u.pathname.slice(1) : host === 'youtube.com' || host === 'm.youtube.com' ? u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|live)\/([^/]+)$/)?.[1] : null;
        return !!id && /^[\w-]{11}$/.test(id);
    }
    catch {
        return false;
    }
}
export function safeMediaUrl(value) {
    if (!value)
        return null;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || /(?:^|\.)(?:invalid|localhost)$/.test(u.hostname) || u.hostname.endsWith('.invalid') || u.username || u.password)
            return null;
        return u.href;
    }
    catch {
        return null;
    }
}
export function timecode(ms) { const sec = Math.floor(ms / 1000); return `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`; }
export function validateSample(input, report) {
    if (input.schemaVersion !== 'audience-clips.v1' || input.research.mode !== 'fixture' || !Array.isArray(input.research.questions) || !Array.isArray(input.clips))
        throw new Error('Sample snapshot unavailable or incompatible.');
    if (!report)
        return;
    if (report.mode !== 'fixture' || report.runId !== input.research.runId || report.schemaVersion !== input.schemaVersion)
        throw new Error('Sample report does not belong to this snapshot.');
    for (const match of report.matches) {
        const q = input.research.questions.find(q => q.id === match.questionId), clip = input.clips.find(c => c.id === match.clipId);
        if (!q || !clip || match.commentEvidenceIds.some(id => !q.evidenceIds.includes(id)))
            throw new Error('Invalid sample evidence reference.');
        for (const p of match.answerPassages) {
            const s = clip.transcript.find(s => s.id === p.clipTranscriptSegmentId);
            if (!s || s.text !== p.quote || s.sourceStartMs !== p.sourceStartMs || s.sourceEndMs !== p.sourceEndMs)
                throw new Error('Sample passage does not match the saved transcript.');
        }
    }
    for (const rec of report.recommendations)
        if (!input.clips.some(c => c.id === rec.clipId) || rec.questionIds.some(id => !input.research.questions.some(q => q.id === id)))
            throw new Error('Invalid recommendation reference.');
}
export class SampleProvider {
    fetcher;
    mode = 'sample';
    available = true;
    records = new Map();
    constructor(fetcher = fetch) {
        this.fetcher = fetcher;
    }
    async json(path) { const fetcher = this.fetcher; const r = await fetcher(path, { cache: 'no-store' }); if (!r.ok)
        throw new Error('Could not load the offline sample. Retry when the local server is available.'); return r.json(); }
    save(record) { this.records.set(record.id, record); return record; }
    async research(videoUrl, goal) {
        const input = await this.json('/sample-input.json');
        validateSample(input);
        return this.save({ id: crypto.randomUUID(), mode: 'sample', videoUrl, goal, input, status: input.research.researchStatus === 'ready' ? 'research_ready' : 'insufficient_evidence' });
    }
    async generate(record, confirmCredits) {
        if (!confirmCredits)
            throw new Error('Acknowledge the credit boundary before loading sample clips.');
        if (!record.input)
            throw new Error('Research must finish first.');
        if (record.status !== 'research_ready' && record.status !== 'generating')
            return record;
        // Only loads an existing synthetic snapshot. No provider submission exists here.
        const input = await this.json('/sample-input.json');
        validateSample(input);
        return this.save({ ...record, input, status: 'reviewing' });
    }
    async review(record) {
        if (!record.input)
            throw new Error('The saved sample input is missing.');
        const report = await this.json('/sample-report.json');
        validateSample(record.input, report);
        return this.save({ ...record, report, status: report.status, error: undefined, failedStage: undefined });
    }
    async observe(id) { const record = this.records.get(id); if (!record)
        throw new Error('Sample not found. Open a new sample; no paid job will be created.'); return record; }
    async retryReview(record) { return this.review(record); }
}
/** Safe connection boundary: unavailable until actual routes and ownership are verified. */
export class UnavailableLiveProvider {
    mode = 'live';
    available = false;
    unavailable() { throw new Error('Live research is not connected to the integration coordinator. Explore the offline sample instead.'); }
    async research(_videoUrl, _goal) { return this.unavailable(); }
    async generate(_record, _confirmCredits) { return this.unavailable(); }
    async review(_record) { return this.unavailable(); }
    async observe(_id) { return this.unavailable(); }
    async retryReview(_record) { return this.unavailable(); }
}
