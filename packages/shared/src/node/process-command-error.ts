import * as NodeBuffer from "node:buffer";
import * as NodeStringDecoder from "node:string_decoder";
import { redactDiagnostic } from "../diagnostics/internal/bound.js";

const DIAGNOSTIC_BYTE_LIMIT = 2_048;
const TRUNCATION_SUFFIX = "[truncated]";

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
    const code = "code" in failure ? failure.code : undefined;
    const signal = "signal" in failure && typeof failure.signal === "string" ? failure.signal : null;
    const killed = "killed" in failure && failure.killed === true;
    return new ProcessCommandError(cause, {
      exitCode: typeof code === "number" ? code : null,
      signal,
      // A timeout has a signal and no exit status. Buffer overflow and abort carry error codes.
      timedOut: code === null && killed && signal !== null,
      stderrExcerpt: excerptStderr("stderr" in failure ? failure.stderr : undefined),
    });
  }

  /** Returns only the logging fields from the first command failure in an error's cause chain. */
  static logFields(error: unknown): (ProcessCommandDiagnostics & { readonly error: string }) | undefined {
    const seen = new Set<object>();
    while (typeof error === "object" && error !== null && !seen.has(error)) {
      if (error instanceof ProcessCommandError) {
        const { exitCode, signal, timedOut, stderrExcerpt } = error;
        // execFile appends stderr to the message. Only the excerpt should carry that output.
        const [summary = ""] = error.message.split(/\r?\n/, 1);
        return { error: redactAndBound(summary), exitCode, signal, timedOut, stderrExcerpt };
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
  return redactAndBound(stderr);
}

function redactAndBound(value: string): string {
  const redacted = redactDiagnostic(value);
  if (NodeBuffer.Buffer.byteLength(redacted) <= DIAGNOSTIC_BYTE_LIMIT) return redacted;
  const prefix = NodeBuffer.Buffer.from(redacted).subarray(0, DIAGNOSTIC_BYTE_LIMIT - TRUNCATION_SUFFIX.length);
  return new NodeStringDecoder.StringDecoder("utf8").write(prefix) + TRUNCATION_SUFFIX;
}
