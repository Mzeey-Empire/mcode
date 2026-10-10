import * as NodeFS from "node:fs";
import type { ReviewComparisonResult } from "@mcode/contracts";

/** A bounded comparison whose complete file count exceeds the Review limit. */
export class ReviewComparisonLimitError extends Error {
  constructor(readonly fileCount: number) {
    super("Review comparison exceeds 10000 files");
  }
}

/** A ref rejected before it can reach Git's argument parser. */
export class UnsafeReviewRefError extends Error {}

/** The selected checkout must never fall back to another repository. */
export class ReviewWorktreeMissingError extends Error {}

/** Require the selected checkout before executing any comparison commands. */
export function assertReviewWorktree(cwd: string): void {
  if (!NodeFS.existsSync(cwd)) throw new ReviewWorktreeMissingError(`Worktree folder is missing: ${cwd}`);
}

/** Preserve executor stderr while classifying expected comparison failures. */
export function reviewComparisonFailure(error: unknown): Exclude<ReviewComparisonResult, { status: "ready" }> {
  if (error instanceof ReviewComparisonLimitError) return { status: "too-many-files", fileCount: error.fileCount, limit: 10_000 };
  const detail = errorDetail(error);
  const kind = failureKind(error);
  const summary = kind === "timeout" ? "Git comparison timed out"
    : kind === "worktree-missing" ? "The worktree folder is missing"
    : kind === "unsafe-ref" ? "The comparison contains an unsafe ref" : "Could not load this comparison";
  return { status: "failed", failure: { kind, summary, detail } };
}

function errorDetail(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string") return error.stderr;
  return error instanceof Error ? error.message : String(error);
}

function failureKind(error: unknown): Extract<ReviewComparisonResult, { status: "failed" }>["failure"]["kind"] {
  if (error instanceof ReviewWorktreeMissingError) return "worktree-missing";
  if (error instanceof UnsafeReviewRefError) return "unsafe-ref";
  if (typeof error === "object" && error !== null && "killed" in error && error.killed === true) return "timeout";
  return "git-error";
}
