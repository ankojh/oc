export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFIG_MISSING"
  | "YOUTUBE_AUTH"
  | "YOUTUBE_QUOTA"
  | "YOUTUBE_NOT_FOUND"
  | "YOUTUBE_ERROR"
  | "CODEX_AUTH"
  | "CODEX_FAILED"
  | "OPUS_AUTH"
  | "OPUS_NO_API_ACCESS"
  | "OPUS_CREDITS_OR_CAP"
  | "OPUS_CONCURRENCY"
  | "OPUS_RATE_LIMIT"
  | "OPUS_BAD_REQUEST"
  | "OPUS_PROCESSING_FAILED"
  | "OPUS_AMBIGUOUS_SUBMIT"
  | "OPUS_UNSUPPORTED"
  | "OPUS_ERROR"
  | "CONFLICT"
  | "INTERRUPTED"
  | "CONTRACT_VIOLATION"
  | "INTERNAL";

/** An error the UI can show as-is: what happened and what the user can do. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly action: string | null = null,
    public readonly httpStatus = 500,
    /** For provider submissions: true only when we know no paid job was created. */
    public readonly definitelyNotCreated = false,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON() {
    return { code: this.code, message: this.message, action: this.action };
  }
}

export function toErrorInfo(err: unknown): { code: ErrorCode; message: string; action: string | null } {
  if (err instanceof AppError) return err.toJSON();
  return { code: "INTERNAL", message: err instanceof Error ? err.message : String(err), action: null };
}
