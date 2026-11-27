import type { WorkspaceMoveFrame, WorkspaceMoveRetryGitResult } from "@mcode/contracts/ws/workspace-move";
import { dirname } from "@/lib/path";
import type { FieldProblem, NewProjectValues } from "./new-project-fields";
import type { MoveBlock } from "./move-thread-store";

/** A refusal that leaves the form open: one field the user can fix, or a thread that must stop first. */
export type FormRefusal =
  /** Holds only for the values it answered, so editing either field clears it. */
  | { readonly kind: "field"; readonly problem: FieldProblem; readonly values: NewProjectValues }
  | { readonly kind: "busy"; readonly threadId: string; readonly reason: MoveBlock };

/**
 * Where a new-project move stands. One value rather than flags, so the dialog cannot show a spinner and a failure
 * together. `revision` orders the frames of one operation, so a stale read never replaces a newer one.
 */
export type NewProjectRun =
  | { readonly kind: "form"; readonly refusal: FormRefusal | null }
  /** `operationId` is null from the click until the server names the operation. */
  | { readonly kind: "moving"; readonly operationId: string | null; readonly revision: number }
  /**
   * `rolled-back`: the folder and the threads are back where they were. `unconfirmed`: the request never answered,
   * so the move may still have happened.
   */
  | { readonly kind: "failed"; readonly error: string; readonly outcome: "rolled-back" | "unconfirmed" }
  /** The rollback itself failed. `folder` holds the files, or is null when the server could not say where. */
  | { readonly kind: "rollback-pending"; readonly operationId: string; readonly revision: number; readonly error: string; readonly folder: string | null }
  /** The project exists and the threads are in it; only git setup failed. `retrying` holds the retry button while a retry runs. */
  | { readonly kind: "git-failed"; readonly operationId: string; readonly workspaceId: string; readonly error: string; readonly retrying: boolean }
  /** A retry started git. The project and its alert stay on screen until the user closes them. */
  | { readonly kind: "git-started"; readonly workspaceId: string }
  | { readonly kind: "created"; readonly workspaceId: string };

/** The starting state: the form, with nothing refused. */
export const FORM_RUN: NewProjectRun = { kind: "form", refusal: null };

/** What changes the run. */
export type NewProjectRunAction =
  | { readonly type: "submitted" }
  /** The user chose something else, so a failed attempt no longer says anything about the dialog. */
  | { readonly type: "reset" }
  | { readonly type: "refused"; readonly refusal: FormRefusal }
  | { readonly type: "failed"; readonly error: string; readonly outcome: "rolled-back" | "unconfirmed" }
  | { readonly type: "started"; readonly operationId: string }
  | { readonly type: "frame"; readonly frame: WorkspaceMoveFrame }
  /** The dialog opened on a thread whose move is already unfinished. */
  | { readonly type: "adopted"; readonly frame: WorkspaceMoveFrame }
  | { readonly type: "git-retrying" }
  | { readonly type: "git-retried"; readonly result: WorkspaceMoveRetryGitResult };

/** The state a frame describes. A frame without a result is a move still running. */
function runOfFrame(frame: WorkspaceMoveFrame): NewProjectRun {
  const { result } = frame;
  if (!result) return { kind: "moving", operationId: frame.operationId, revision: frame.revision };
  switch (result.status) {
    case "created":
      return { kind: "created", workspaceId: result.workspaceId };
    case "git-failed":
      return { kind: "git-failed", operationId: frame.operationId, workspaceId: result.workspaceId, error: result.error, retrying: false };
    case "failed":
      return { kind: "failed", error: result.error, outcome: "rolled-back" };
    case "rollback-pending":
      // The server records where the marker file is; the files are in the folder that holds it.
      return {
        kind: "rollback-pending",
        operationId: frame.operationId,
        revision: frame.revision,
        error: result.error,
        folder: result.markerPath === null ? null : dirname(result.markerPath),
      };
    default:
      throw new Error(`Unhandled move result: ${result satisfies never}`);
  }
}

/** The operation and revision a run follows, or null when it follows none. */
function followed(run: NewProjectRun): { readonly operationId: string; readonly revision: number } | null {
  if ((run.kind === "moving" || run.kind === "rollback-pending") && run.operationId !== null) {
    return { operationId: run.operationId, revision: run.revision };
  }
  return null;
}

/** The operation a run still follows, so a host knows whether to keep listening for its frames. */
export function followedOperation(run: NewProjectRun): string | null {
  return followed(run)?.operationId ?? null;
}

/** Whether the dialog is past the form: a move is running, or has ended in something the user must read. */
export function isPastForm(run: NewProjectRun): boolean {
  return run.kind !== "form";
}

/**
 * Whether the thread has left No project, or is about to, while the dialog still has a result to show. The dialog
 * closes on a thread that left No project for any other reason, so these states must say they are the reason.
 */
export function followsMove(run: NewProjectRun): boolean {
  return run.kind === "moving" || run.kind === "git-failed" || run.kind === "git-started" || run.kind === "rollback-pending";
}

function applyFrame(run: NewProjectRun, frame: WorkspaceMoveFrame): NewProjectRun {
  const current = followed(run);
  // Two reads of one operation can arrive in either order, so only a higher revision moves the run.
  if (!current || current.operationId !== frame.operationId || frame.revision <= current.revision) return run;
  return runOfFrame(frame);
}

// A retry that could not even run leaves the project as it was, so the alert stays and shows that failure.
function runAfterGitRetry(run: Extract<NewProjectRun, { kind: "git-failed" }>, result: WorkspaceMoveRetryGitResult): NewProjectRun {
  if (result.status === "created") return { kind: "git-started", workspaceId: result.workspaceId };
  return { ...run, error: result.error, retrying: false };
}

type FollowUpAction = Extract<NewProjectRunAction, { type: "frame" | "adopted" | "git-retrying" | "git-retried" }>;

/** The actions that report on a move already running, or on the git retry after it. */
function followUp(run: NewProjectRun, action: FollowUpAction): NewProjectRun {
  switch (action.type) {
    case "frame":
      return applyFrame(run, action.frame);
    case "adopted":
      return run.kind === "form" ? runOfFrame(action.frame) : run;
    case "git-retrying":
      return run.kind === "git-failed" ? { ...run, retrying: true } : run;
    case "git-retried":
      return run.kind === "git-failed" ? runAfterGitRetry(run, action.result) : run;
  }
}

/** The actions that come from the user, and from the server's answer to the request they made. */
function respond(run: NewProjectRun, action: Exclude<NewProjectRunAction, FollowUpAction>): NewProjectRun {
  switch (action.type) {
    case "submitted":
      return { kind: "moving", operationId: null, revision: -1 };
    case "reset":
      return run.kind === "failed" || run.kind === "form" ? FORM_RUN : run;
    case "refused":
      return { kind: "form", refusal: action.refusal };
    case "failed":
      return { kind: "failed", error: action.error, outcome: action.outcome };
    case "started":
      return run.kind === "moving" && run.operationId === null ? { ...run, operationId: action.operationId } : run;
  }
}

/** Moves the run on. */
export function newProjectRunReducer(run: NewProjectRun, action: NewProjectRunAction): NewProjectRun {
  switch (action.type) {
    case "frame":
    case "adopted":
    case "git-retrying":
    case "git-retried":
      return followUp(run, action);
    default:
      return respond(run, action);
  }
}
