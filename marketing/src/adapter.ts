/** Frontend projection of audience-clips.v1. Does not replace either agent validator.
 * No coordinator routes have been invented. Implement WorkbenchProvider against
 * the coordinator's documented routes when available, never the paid provider directly.
 */
export interface Evidence { id: string; quote: string; url: string; commentId: string; videoId: string; publishedAt: string }
export interface Question { id: string; question: string; kind: 'explicit' | 'inferred'; evidenceIds: string[]; observedCommentCount: number; rationale: string; priority: number }
export interface SourceSegment { id: string; startMs: number; endMs: number; text: string }
export interface Clip { id: string; title: string; previewUrl: string | null; exportUrl: string | null; sourceRanges: {startMs: number; endMs: number}[]; transcriptStatus: 'available' | 'unavailable'; transcript: {id: string; sourceStartMs: number; sourceEndMs: number; text: string}[] }
export interface Research { schemaVersion: 'audience-clips.v1'; runId: string; mode: 'fixture' | 'live'; video: {url: string; videoId: string; channelId: string; title: string}; researchStatus: 'ready' | 'insufficient_evidence'; coverage: {commentCount: number; samplingMethod: string; limitations: string[]}; evidence: Evidence[]; questions: Question[] }
export interface ReviewInput { schemaVersion: 'audience-clips.v1'; research: Research; generation: {projectId: string}; sourceTranscript: {coverage: 'full' | 'partial' | 'unavailable'; segments: SourceSegment[]; limitations: string[]}; clips: Clip[]; limitations: string[] }
export type Verdict = 'direct' | 'partial' | 'related_only' | 'no_match' | 'unverifiable';
export interface Match {questionId: string; clipId: string; verdict: Verdict; explanation: string; commentEvidenceIds: string[]; answerPassages: {clipTranscriptSegmentId: string; quote: string; sourceStartMs: number; sourceEndMs: number}[]; limitations: string[]; contextWarnings: {explanation: string; sourceSegmentIds: string[]}[]}
export interface Report {schemaVersion: 'audience-clips.v1'; runId: string; mode: 'fixture' | 'live'; status: 'complete' | 'insufficient_evidence' | 'unverifiable'; matches: Match[]; recommendations: {rank: number; clipId: string; questionIds: string[]; reason: string}[]; unansweredQuestions: {questionId: string; status: string; explanation: string}[]; limitations: string[]}
export type Stage = 'idle' | 'researching' | 'research_ready' | 'generating' | 'needs_reconciliation' | 'reviewing' | 'complete' | 'insufficient_evidence' | 'unavailable_transcript' | 'no_match' | 'unverifiable' | 'failed';
export interface WorkbenchRecord {id: string; mode: 'sample' | 'live'; videoUrl: string; goal: string; status: Stage; input?: ReviewInput; report?: Report; failedStage?: 'research' | 'generation' | 'review'; error?: string}
export interface WorkbenchProvider {
  readonly mode: 'sample' | 'live'; readonly available: boolean;
  research(videoUrl: string, goal: string): Promise<WorkbenchRecord>;
  generate(record: WorkbenchRecord, confirmCredits: boolean): Promise<WorkbenchRecord>;
  review(record: WorkbenchRecord): Promise<WorkbenchRecord>;
  observe(id: string): Promise<WorkbenchRecord>;
  retryReview(record: WorkbenchRecord): Promise<WorkbenchRecord>;
}
export function isYouTubeUrl(value: string): boolean {
  try {const u = new URL(value); if (u.protocol !== 'https:') return false; const host = u.hostname.toLowerCase().replace(/^www\./, ''); const id = host === 'youtu.be' ? u.pathname.slice(1) : host === 'youtube.com' || host === 'm.youtube.com' ? u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|live)\/([^/]+)$/)?.[1] : null; return !!id && /^[\w-]{11}$/.test(id);} catch {return false;}
}
export function safeMediaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {const u = new URL(value); if (u.protocol !== 'https:' || /(?:^|\.)(?:invalid|localhost)$/.test(u.hostname) || u.hostname.endsWith('.invalid') || u.username || u.password) return null; return u.href;} catch {return null;}
}
export function timecode(ms: number): string {const sec = Math.floor(ms / 1000); return `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;}
export function validateSample(input: ReviewInput, report?: Report): void {
  if (input.schemaVersion !== 'audience-clips.v1' || input.research.mode !== 'fixture' || !Array.isArray(input.research.questions) || !Array.isArray(input.clips)) throw new Error('Sample snapshot unavailable or incompatible.');
  if (!report) return;
  if (report.mode !== 'fixture' || report.runId !== input.research.runId || report.schemaVersion !== input.schemaVersion) throw new Error('Sample report does not belong to this snapshot.');
  for (const match of report.matches) {
    const q = input.research.questions.find(q => q.id === match.questionId), clip = input.clips.find(c => c.id === match.clipId);
    if (!q || !clip || match.commentEvidenceIds.some(id => !q.evidenceIds.includes(id))) throw new Error('Invalid sample evidence reference.');
    for (const p of match.answerPassages) {const s = clip.transcript.find(s => s.id === p.clipTranscriptSegmentId); if (!s || s.text !== p.quote || s.sourceStartMs !== p.sourceStartMs || s.sourceEndMs !== p.sourceEndMs) throw new Error('Sample passage does not match the saved transcript.');}
  }
  for (const rec of report.recommendations) if (!input.clips.some(c => c.id === rec.clipId) || rec.questionIds.some(id => !input.research.questions.some(q => q.id === id))) throw new Error('Invalid recommendation reference.');
}
export class SampleProvider implements WorkbenchProvider {
  readonly mode = 'sample' as const; readonly available = true;
  private records = new Map<string, WorkbenchRecord>();
  constructor(private fetcher: typeof fetch = fetch) {}
  private async json<T>(path: string): Promise<T> {const fetcher = this.fetcher; const r = await fetcher(path, {cache:'no-store'}); if (!r.ok) throw new Error('Could not load the offline sample. Retry when the local server is available.'); return r.json() as Promise<T>;}
  private save(record: WorkbenchRecord): WorkbenchRecord {this.records.set(record.id, record); return record;}
  async research(videoUrl: string, goal: string): Promise<WorkbenchRecord> {
    const input = await this.json<ReviewInput>('/sample-input.json'); validateSample(input);
    return this.save({id:crypto.randomUUID(), mode:'sample', videoUrl, goal, input, status:input.research.researchStatus === 'ready' ? 'research_ready' : 'insufficient_evidence'});
  }
  async generate(record: WorkbenchRecord, confirmCredits: boolean): Promise<WorkbenchRecord> {
    if (!confirmCredits) throw new Error('Acknowledge the credit boundary before loading sample clips.');
    if (!record.input) throw new Error('Research must finish first.');
    if (record.status !== 'research_ready' && record.status !== 'generating') return record;
    // Only loads an existing synthetic snapshot. No provider submission exists here.
    const input = await this.json<ReviewInput>('/sample-input.json'); validateSample(input);
    return this.save({...record, input, status:'reviewing'});
  }
  async review(record: WorkbenchRecord): Promise<WorkbenchRecord> {
    if (!record.input) throw new Error('The saved sample input is missing.');
    const report = await this.json<Report>('/sample-report.json'); validateSample(record.input, report);
    return this.save({...record, report, status:report.status, error:undefined, failedStage:undefined});
  }
  async observe(id: string): Promise<WorkbenchRecord> {const record=this.records.get(id); if (!record) throw new Error('Sample not found. Open a new sample; no paid job will be created.'); return record;}
  async retryReview(record: WorkbenchRecord): Promise<WorkbenchRecord> {return this.review(record);}
}
/** Safe connection boundary: unavailable until actual routes and ownership are verified. */
export class UnavailableLiveProvider implements WorkbenchProvider {
  readonly mode = 'live' as const; readonly available = false;
  private unavailable(): never {throw new Error('Live research is not connected to the integration coordinator. Explore the offline sample instead.');}
  async research(_videoUrl: string, _goal: string): Promise<WorkbenchRecord> {return this.unavailable();}
  async generate(_record: WorkbenchRecord, _confirmCredits: boolean): Promise<WorkbenchRecord> {return this.unavailable();}
  async review(_record: WorkbenchRecord): Promise<WorkbenchRecord> {return this.unavailable();}
  async observe(_id: string): Promise<WorkbenchRecord> {return this.unavailable();}
  async retryReview(_record: WorkbenchRecord): Promise<WorkbenchRecord> {return this.unavailable();}
}
