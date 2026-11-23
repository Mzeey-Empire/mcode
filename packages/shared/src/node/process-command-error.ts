import * as NodeBuffer from "node:buffer";

const STDERR_EXCERPT_LIMIT = 2_048;
const STDERR_TRUNCATION_SUFFIX = "[truncated]";

interface ProcessCommandDiagnostics {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stderrExcerpt: string;
}

/** Carries bounded command diagnostics while preserving the original error message. */
export class ProcessCommandError extends Error implements ProcessCommandDiagnostics {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stderrExcerpt: string;

  private constructor(cause: unknown, diagnostics: ProcessCommandDiagnostics) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    if (cause instanceof Error) this.name = cause.name;
    this.exitCode = diagnostics.exitCode;
    this.signal = diagnostics.signal;
    this.timedOut = diagnostics.timedOut;
    this.stderrExcerpt = diagnostics.stderrExcerpt;
  }

  /** Builds diagnostics from a rejected Node execFile call. */
  static fromExecFileError(cause: unknown): ProcessCommandError {
    const failure = cause instanceof Error ? cause : {};
    const code = "code" in failure ? failure.code : null;
    const signal = "signal" in failure && typeof failure.signal === "string" ? failure.signal : null;
    const killed = "killed" in failure && failure.killed === true;
    return new ProcessCommandError(cause, {
      exitCode: typeof code === "number" ? code : null,
      signal,
      timedOut: code === "ETIMEDOUT" || (killed && signal !== null),
      stderrExcerpt: excerptStderr("stderr" in failure ? failure.stderr : undefined),
    });
  }

  /** Returns only the logging fields from the first command failure in an error's cause chain. */
  static logFields(error: unknown): ProcessCommandDiagnostics | undefined {
    const seen = new Set<object>();
    while (typeof error === "object" && error !== null && !seen.has(error)) {
      if (error instanceof ProcessCommandError) {
        const { exitCode, signal, timedOut, stderrExcerpt } = error;
        return { exitCode, signal, timedOut, stderrExcerpt };
      }
      seen.add(error);
      error = "cause" in error ? error.cause : undefined;
    }
    return undefined;
  }
}

function excerptStderr(stderr: unknown): string {
  if (NodeBuffer.Buffer.isBuffer(stderr)) stderr = stderr.toString("utf8");
  if (typeof stderr !== "string") return "";
  if (stderr.length <= STDERR_EXCERPT_LIMIT) return stderr;
  return stderr.slice(0, STDERR_EXCERPT_LIMIT - STDERR_TRUNCATION_SUFFIX.length) + STDERR_TRUNCATION_SUFFIX;
}
