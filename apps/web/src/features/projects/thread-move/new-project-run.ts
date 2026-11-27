import type {
  WorkspaceMoveCopyLeftover,
  WorkspaceMoveFailureCause,
  WorkspaceMoveFrame,
  WorkspaceMoveRetryGitResult,
} from "@mcode/contracts/ws/workspace-move";
import { dirname } from "@/lib/path";
import type { FieldProblem, NewProjectValues } from "./new-project-fields";
import type { MoveBlock } from "./move-thread-store";

/** A refusal that leaves the form open: one field the user can fix, or a thread that must stop first. */
export type FormRefusal =
  /** Holds only for the values it answered, so editing either field clears it. */
  | { readonly kind: "field"; readonly problem: FieldProblem; readonly values: NewProjectValues }
  | { readonly kind: "busy"; readonly threadId: string; readonly reason: MoveBlock };

export interface CopyProgress {
  readonly copiedBytes: number;
  readonly totalBytes: number;
}

/**
 * Where a new-project move stands. One value rather than flags, so the dialog cannot show a spinner and a failure
 * together. `revision` orders the frames of one operation, so a stale read never replaces a newer one.
 */
export type NewProjectRun =
  | { readonly kind: "form"; readonly refusal: FormRefusal | null }
  | { readonly kind: "moving"; readonly operationId: string | null; readonly revision: number; readonly copy: CopyProgress | null }
  /**
   * `rolled-back`: the folder and the threads are back where they were. `copy` describes what a cross-drive move left behind.
   */
  | {
    readonly kind: "failed";
    readonly error: string;
    readonly outcome: "rolled-back";
    readonly cause: WorkspaceMoveFailureCause;
    readonly copy: WorkspaceMoveCopyLeftover | null;
  }
  /** The request never answered, so the move may still have happened and nothing says why it failed. */
  | { readonly kind: "failed"; readonly error: string; readonly outcome: "unconfirmed" }
  /**
   * The rollback itself failed. `folder` holds the files, or is null when the server could not say where.
   */
  | {
    readonly kind: "rollback-pending";
    readonly operationId: string;
    readonly revision: number;
    readonly error: string;
    readonly folder: string | null;
    readonly copyPath: string | null;
  }
  /**
   * The status of a move that was started could not be read, and no frame arrived to say how it ended. Nothing is
   * known about where the thread is, so the user is sent to the sidebar rather than offered a retry that could
   * start a second move.
   */
  | { readonly kind: "result-unknown"; readonly operationId: string; readonly revision: number }
  /** The project exists and the threads are in it; only git setup failed. `retrying` holds the retry button while a retry runs. */
  | { readonly kind: "git-failed"; readonly operationId: string; readonly workspaceId: string; readonly error: string; readonly retrying: boolean }
  /** A retry started git. The project and its alert stay on screen until the user closes them. */
  | { readonly kind: "git-started"; readonly workspaceId: string }
  | { readonly kind: "created"; readonly workspaceId: string };

export const FORM_RUN: NewProjectRun = { kind: "form", refusal: null };

export type NewProjectRunAction =
  | { readonly type: "submitted" }
  | { readonly type: "reset" }
  | { readonly type: "refused"; readonly refusal: FormRefusal }
  | { readonly type: "failed"; readonly error: string; readonly outcome: "rolled-back"; readonly cause: WorkspaceMoveFailureCause }
  | { readonly type: "failed"; readonly error: string; readonly outcome: "unconfirmed" }
  | { readonly type: "started"; readonly operationId: string }
  | { readonly type: "result-unreadable"; readonly operationId: string }
  | { readonly type: "frame"; readonly frame: WorkspaceMoveFrame }
  | { readonly type: "adopted"; readonly frame: WorkspaceMoveFrame }
  | { readonly type: "git-retrying" }
  | { readonly type: "git-retried"; readonly result: WorkspaceMoveRetryGitResult };

function copyOfFrame({ copiedBytes, totalBytes }: WorkspaceMoveFrame): CopyProgress | null {
  return copiedBytes !== null && totalBytes !== null ? { copiedBytes, totalBytes } : null;
}

/**
 * Whether a failed move is about where the user chose to put the project, so the dialog marks Location and puts the
 * notice under it. A full drive and a refused write are about the destination wherever they happen. `other` is about
 * it only for a copy to another drive, where the unknown failure came from writing there; a file in use is about the
 * folder being moved, and an unconfirmed request says nothing about any field.
 */
export function failureIsAboutLocation(failure: Extract<NewProjectRun, { kind: "failed" }>): boolean {
  if (failure.outcome === "unconfirmed") return false;
  switch (failure.cause.kind) {
    case "no-space":
    case "permission":
      return true;
    case "other":
      return failure.copy !== null;
    case "in-use":
      return false;
    default:
      throw new Error(`Unhandled move failure cause: ${failure.cause satisfies never}`);
  }
}

function runOfFrame(frame: WorkspaceMoveFrame): NewProjectRun {
  const { result } = frame;
  if (!result) return { kind: "moving", operationId: frame.operationId, revision: frame.revision, copy: copyOfFrame(frame) };
  switch (result.status) {
    case "created":
      return { kind: "created", workspaceId: result.workspaceId };
    case "git-failed":
      return { kind: "git-failed", operationId: frame.operationId, workspaceId: result.workspaceId, error: result.error, retrying: false };
    case "failed":
      return { kind: "failed", error: result.error, outcome: "rolled-back", cause: result.cause, copy: result.copy };
    case "rollback-pending":
      // The server records where the marker file is; the files are in the folder that holds it.
      return {
        kind: "rollback-pending",
        operationId: frame.operationId,
        revision: frame.revision,
        error: result.error,
        folder: result.markerPath === null ? null : dirname(result.markerPath),
        copyPath: result.copyPath,
      };
    default:
      throw new Error(`Unhandled move result: ${result satisfies never}`);
  }
}

function followed(run: NewProjectRun): { readonly operationId: string; readonly revision: number } | null {
  if ((run.kind === "moving" || run.kind === "rollback-pending" || run.kind === "result-unknown") && run.operationId !== null) {
    return { operationId: run.operationId, revision: run.revision };
  }
  return null;
}

export function followedOperation(run: NewProjectRun): string | null {
  return followed(run)?.operationId ?? null;
}

export function isPastForm(run: NewProjectRun): boolean {
  return run.kind !== "form";
}

/**
 * Whether the thread has left No project, or is about to, while the dialog still has a result to show. The dialog
 * closes on a thread that left No project for any other reason, so these states must say they are the reason.
 */
export function followsMove(run: NewProjectRun): boolean {
  return run.kind === "moving" || run.kind === "git-failed" || run.kind === "git-started" || run.kind === "rollback-pending" || run.kind === "result-unknown";
}

/** A move ended in a state where the form no longer applies and the only way on is to close the dialog. */
export function endsAtClose(run: NewProjectRun): boolean {
  return run.kind === "rollback-pending" || run.kind === "result-unknown";
}

function applyFrame(run: NewProjectRun, frame: WorkspaceMoveFrame): NewProjectRun {
  const current = followed(run);
  if (!current || current.operationId !== frame.operationId || frame.revision < current.revision) return run;
  if (frame.revision === current.revision && run.kind !== "result-unknown") return run;
  return runOfFrame(frame);
}

function runAfterGitRetry(run: Extract<NewProjectRun, { kind: "git-failed" }>, result: WorkspaceMoveRetryGitResult): NewProjectRun {
  if (result.status === "created") return { kind: "git-started", workspaceId: result.workspaceId };
  return { ...run, error: result.error, retrying: false };
}

function runAfterUnreadableStatus(run: NewProjectRun, operationId: string): NewProjectRun {
  return run.kind === "moving" && run.operationId === operationId
    ? { kind: "result-unknown", operationId, revision: run.revision }
    : run;
}

type FollowUpAction =Extract<NewProjectRunAction, { type: "frame" | "adopted" | "result-unreadable" | "git-retrying" | "git-retried" }>;

function followUp(run: NewProjectRun, action: FollowUpAction): NewProjectRun {
  switch (action.type) {
    case "result-unreadable":
      return runAfterUnreadableStatus(run, action.operationId);
    case "frame":
      return applyFrame(run, action.frame);
    case "adopted":
      // The lookup finds a move that was already running, so it is followed from whatever the run shows by now. A
      // run that already follows that operation keeps whichever frame is newer.
      return followedOperation(run) === action.frame.operationId ? applyFrame(run, action.frame) : runOfFrame(action.frame);
    case "git-retrying":
      return run.kind === "git-failed" ? { ...run, retrying: true } : run;
    case "git-retried":
      return run.kind === "git-failed" ? runAfterGitRetry(run, action.result) : run;
  }
}

/** A request that failed before any frame arrived copied nothing, so `copy` is null. */
function runOfRequestFailure(action: Extract<NewProjectRunAction, { type: "failed" }>): NewProjectRun {
  return action.outcome === "unconfirmed"
    ? { kind: "failed", error: action.error, outcome: "unconfirmed" }
    : { kind: "failed", error: action.error, outcome: "rolled-back", cause: action.cause, copy: null };
}

function respond(run: NewProjectRun, action: Exclude<NewProjectRunAction, FollowUpAction>): NewProjectRun {
  switch (action.type) {
    case "submitted":
      return { kind: "moving", operationId: null, revision: -1, copy: null };
    case "reset":
      return run.kind === "failed" || run.kind === "form" ? FORM_RUN : run;
    case "refused":
      return { kind: "form", refusal: action.refusal };
    case "failed":
      return runOfRequestFailure(action);
    case "started":
      return run.kind === "moving" && run.operationId === null ? { ...run, operationId: action.operationId } : run;
  }
}

export function newProjectRunReducer(run: NewProjectRun, action: NewProjectRunAction): NewProjectRun {
  switch (action.type) {
    case "frame":
    case "adopted":
    case "result-unreadable":
    case "git-retrying":
    case "git-retried":
      return followUp(run, action);
    default:
      return respond(run, action);
  }
}
