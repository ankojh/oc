import type { Evidence, Stage, Verdict } from './adapter.js';
/** Projection of integration/src/view.ts; API ownership remains with the coordinator. */
export interface ClipView {
    id: string;
    title: string;
    previewUrl: string | null;
    exportUrl: string | null;
    sourceRanges: {
        startMs: number;
        endMs: number;
    }[];
    rangesDurationMs: number;
    transcriptStatus: string;
    verifiable: boolean;
    sourceLink: string | null;
}
export interface MatchView {
    clipId: string;
    clipTitle: string;
    verdict: Verdict;
    explanation: string;
    answerPassages: {
        quote: string;
        sourceStartMs: number;
        sourceEndMs: number;
        clipOffsetMs: number | null;
        sourceLink: string;
    }[];
    contextWarnings: {
        explanation: string;
        sourceSegments: {
            text: string | null;
            sourceLink: string | null;
            startMs: number | null;
            endMs: number | null;
        }[];
    }[];
    limitations: string[];
}
export interface CoordinatorView {
    integrationId: string;
    mode: 'fixture' | 'live';
    modeLabel: string;
    status: Stage;
    statusText: string;
    updatedAt: string;
    failedStage: string | null;
    error: {
        code: string;
        message: string;
        action: string | null;
    } | null;
    input: {
        videoUrl: string;
        creatorGoal: string | null;
    };
    actions: {
        generate: boolean;
        reconcile: boolean;
        adoptProject: boolean;
        resumePolling: boolean;
        retryReview: boolean;
        retryHandoff: boolean;
    };
    research: {
        video: {
            title: string;
            url: string;
        } | null;
        coverage: {
            commentCount: number;
            videoIds: string[];
            samplingMethod: string;
            limitations: string[];
        } | null;
        progress: {
            message: string;
        }[];
    };
    generation: {
        stage: string | null;
        creditNotice: string | null;
        projectId: string | null;
        events: {
            message: string;
        }[];
        reconciliation: {
            note?: string;
            candidates?: {
                projectId: string;
                title: string;
                createdAt: string | null;
            }[];
        } | null;
    };
    handoff: {
        hash: string | null;
        limitations: string[];
        sourceTranscript: {
            coverage: string;
            segmentCount: number;
            limitations: string[];
        } | null;
    };
    review: {
        reviewId: string | null;
        progress: {
            step: string;
        }[];
    };
    questions: {
        id: string;
        question: string;
        kind: string;
        observedCommentCount: number;
        rationale: string;
        evidence: Evidence[];
        recommendations: {
            rank: number;
            reason: string;
            clip: ClipView | null;
            match: MatchView | null;
        }[];
        unanswered: {
            status: string;
            explanation: string;
        } | null;
        checked: MatchView[];
    }[];
    clips: ClipView[];
    report: {
        status: string;
        limitations: string[];
        recommendationCount: number;
    } | null;
    diagnostics: unknown;
}
export interface Connection {
    coordinator: boolean;
    services: boolean;
    liveResearchAvailable: boolean;
    message: string;
}
export declare class CoordinatorProvider {
    private fetcher;
    constructor(fetcher?: typeof fetch);
    private request;
    connection(): Promise<Connection>;
    research(mode: 'fixture' | 'live', videoUrl: string, creatorGoal: string): Promise<CoordinatorView>;
    observe(id: string): Promise<CoordinatorView>;
    generate(id: string, confirmCredits: boolean): Promise<CoordinatorView>;
    retryReview(id: string): Promise<CoordinatorView>;
    retryHandoff(id: string): Promise<CoordinatorView>;
    resumePolling(id: string): Promise<CoordinatorView>;
    reconcile(id: string): Promise<CoordinatorView>;
    adopt(id: string, projectId: string): Promise<CoordinatorView>;
}
