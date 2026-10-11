/** Frontend projection of audience-clips.v1. Does not replace either agent validator.
 * No coordinator routes have been invented. Implement WorkbenchProvider against
 * the coordinator's documented routes when available, never the paid provider directly.
 */
export interface Evidence {
    id: string;
    quote: string;
    url: string;
    commentId: string;
    videoId: string;
    publishedAt: string;
}
export interface Question {
    id: string;
    question: string;
    kind: 'explicit' | 'inferred';
    evidenceIds: string[];
    observedCommentCount: number;
    rationale: string;
    priority: number;
}
export interface SourceSegment {
    id: string;
    startMs: number;
    endMs: number;
    text: string;
}
export interface Clip {
    id: string;
    title: string;
    previewUrl: string | null;
    exportUrl: string | null;
    sourceRanges: {
        startMs: number;
        endMs: number;
    }[];
    transcriptStatus: 'available' | 'unavailable';
    transcript: {
        id: string;
        sourceStartMs: number;
        sourceEndMs: number;
        text: string;
    }[];
}
export interface Research {
    schemaVersion: 'audience-clips.v1';
    runId: string;
    mode: 'fixture' | 'live';
    video: {
        url: string;
        videoId: string;
        channelId: string;
        title: string;
    };
    researchStatus: 'ready' | 'insufficient_evidence';
    coverage: {
        commentCount: number;
        samplingMethod: string;
        limitations: string[];
    };
    evidence: Evidence[];
    questions: Question[];
}
export interface ReviewInput {
    schemaVersion: 'audience-clips.v1';
    research: Research;
    generation: {
        projectId: string;
    };
    sourceTranscript: {
        coverage: 'full' | 'partial' | 'unavailable';
        segments: SourceSegment[];
        limitations: string[];
    };
    clips: Clip[];
    limitations: string[];
}
export type Verdict = 'direct' | 'partial' | 'related_only' | 'no_match' | 'unverifiable';
export interface Match {
    questionId: string;
    clipId: string;
    verdict: Verdict;
    explanation: string;
    commentEvidenceIds: string[];
    answerPassages: {
        clipTranscriptSegmentId: string;
        quote: string;
        sourceStartMs: number;
        sourceEndMs: number;
    }[];
    limitations: string[];
    contextWarnings: {
        explanation: string;
        sourceSegmentIds: string[];
    }[];
}
export interface Report {
    schemaVersion: 'audience-clips.v1';
    runId: string;
    mode: 'fixture' | 'live';
    status: 'complete' | 'insufficient_evidence' | 'unverifiable';
    matches: Match[];
    recommendations: {
        rank: number;
        clipId: string;
        questionIds: string[];
        reason: string;
    }[];
    unansweredQuestions: {
        questionId: string;
        status: string;
        explanation: string;
    }[];
    limitations: string[];
}
export type Stage = 'idle' | 'researching' | 'research_ready' | 'generating' | 'needs_reconciliation' | 'reviewing' | 'complete' | 'insufficient_evidence' | 'unavailable_transcript' | 'no_match' | 'unverifiable' | 'failed';
export interface WorkbenchRecord {
    id: string;
    mode: 'sample' | 'live';
    videoUrl: string;
    goal: string;
    status: Stage;
    input?: ReviewInput;
    report?: Report;
    failedStage?: 'research' | 'generation' | 'review';
    error?: string;
}
export interface WorkbenchProvider {
    readonly mode: 'sample' | 'live';
    readonly available: boolean;
    research(videoUrl: string, goal: string): Promise<WorkbenchRecord>;
    generate(record: WorkbenchRecord, confirmCredits: boolean): Promise<WorkbenchRecord>;
    review(record: WorkbenchRecord): Promise<WorkbenchRecord>;
    observe(id: string): Promise<WorkbenchRecord>;
    retryReview(record: WorkbenchRecord): Promise<WorkbenchRecord>;
}
export declare function isYouTubeUrl(value: string): boolean;
export declare function safeMediaUrl(value: string | null | undefined): string | null;
export declare function timecode(ms: number): string;
export declare function validateSample(input: ReviewInput, report?: Report): void;
export declare class SampleProvider implements WorkbenchProvider {
    private fetcher;
    readonly mode: "sample";
    readonly available = true;
    private records;
    constructor(fetcher?: typeof fetch);
    private json;
    private save;
    research(videoUrl: string, goal: string): Promise<WorkbenchRecord>;
    generate(record: WorkbenchRecord, confirmCredits: boolean): Promise<WorkbenchRecord>;
    review(record: WorkbenchRecord): Promise<WorkbenchRecord>;
    observe(id: string): Promise<WorkbenchRecord>;
    retryReview(record: WorkbenchRecord): Promise<WorkbenchRecord>;
}
/** Safe connection boundary: unavailable until actual routes and ownership are verified. */
export declare class UnavailableLiveProvider implements WorkbenchProvider {
    readonly mode: "live";
    readonly available = false;
    private unavailable;
    research(_videoUrl: string, _goal: string): Promise<WorkbenchRecord>;
    generate(_record: WorkbenchRecord, _confirmCredits: boolean): Promise<WorkbenchRecord>;
    review(_record: WorkbenchRecord): Promise<WorkbenchRecord>;
    observe(_id: string): Promise<WorkbenchRecord>;
    retryReview(_record: WorkbenchRecord): Promise<WorkbenchRecord>;
}
