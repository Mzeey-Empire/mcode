import type { ReactNode } from "react";
import { Notice } from "@/components/ui/notice";
import { BreakablePath } from "./BreakablePath";
import type { MoveBlock } from "./move-thread-store";
import type { NewProjectRun } from "./new-project-run";

/** A thread in the folder that cannot move yet, and why. */
export interface BusyThread {
  readonly title: string;
  readonly reason: MoveBlock;
  readonly isOpenThread: boolean;
}

export function BusyNotice({ busy }: { readonly busy: BusyThread }) {
  const wait = {
    running: "You can move once it stops.",
    "needs-approval": "You can move once you answer it.",
    background: "You can move once that work stops.",
  }[busy.reason];
  const state = { running: "is running", "needs-approval": "needs approval", background: "has work running in the background" }[busy.reason];
  return (
    <Notice
      tone="info"
      title={`“${busy.title}” ${state}`}
      detail={`${busy.isOpenThread ? "" : "It works in this folder, so it moves with the new project. "}${wait}`}
    />
  );
}

/** Says which other threads the new project takes along. A new project takes the whole folder. */
export function SharersNotice({ titles, count }: { readonly titles: readonly string[]; readonly count: number }) {
  const title = count === 1 ? "1 other thread works in this folder and moves with it" : `${count} other threads work in this folder and move with it`;
  return (
    <Notice
      tone="info"
      title={title}
      detail={
        <ul className="grid gap-0.5">
          {titles.map((threadTitle, index) => <li key={`${index}:${threadTitle}`} className="min-w-0 text-fade">{threadTitle}</li>)}
        </ul>
      }
    />
  );
}

/** Shown when the move was started but nothing could say how it ended. */
export function ResultUnknownNotice() {
  return <Notice tone="error" title="Couldn't get the result of the move. Check the sidebar to see where the thread is." />;
}

export type FolderMoveFailure = Extract<NewProjectRun, { kind: "failed" | "rollback-pending" }>;

type FailedMove = Extract<NewProjectRun, { kind: "failed" }>;

function stillInNoProject(threadCount: number): string {
  return threadCount > 1 ? "the threads are still in No project" : "the thread is still in No project";
}

function unconfirmedDetail(threadCount: number): string {
  return `Mcode could not confirm the move. ${threadCount > 1 ? "The threads stay" : "The thread stays"} in No project here until Mcode hears that it moved.`;
}

/** What to do next, by what went wrong. Only a full drive names the drive. `copied` is whether the move copied to another drive. */
function failureAdvice({ cause }: FailedMove, copied: boolean): string {
  switch (cause.kind) {
    case "no-space":
      return `Free up space on ${cause.drive} and try again, or choose another location.`;
    case "permission":
      return "Choose a location you can write to, then try again.";
    case "in-use":
      return "Close any app using files in the folder, then try again.";
    case "other":
      return copied ? "Try again, or choose another location." : "Try again in a moment.";
    default:
      throw new Error(`Unhandled move failure cause: ${cause satisfies never}`);
  }
}

/**
 * The title of a failed move. A full drive and a refused write are about the destination, so they say so, and say
 * "copied" only when a copy to another drive ran. A file in use is not about the destination, so it keeps the folder move's title.
 */
function failedTitle({ cause, partialCopyRemoved }: FailedMove, folderMoveTitle: string): string {
  const action = partialCopyRemoved === null ? "moved" : "copied";
  switch (cause.kind) {
    case "no-space":
      return `Drive ${cause.drive} is full, so the folder couldn't be ${action} there`;
    case "permission":
      return `Permission was denied, so the folder couldn't be ${action} there`;
    case "in-use":
      return folderMoveTitle;
    case "other":
      return partialCopyRemoved === null ? folderMoveTitle : "The folder couldn't be copied there";
    default:
      throw new Error(`Unhandled move failure cause: ${cause satisfies never}`);
  }
}

function failedDetail(failure: FailedMove, threadCount: number): string {
  if (failure.outcome === "unconfirmed") return unconfirmedDetail(threadCount);
  const { partialCopyRemoved } = failure;
  if (partialCopyRemoved === null) return `Nothing changed: ${stillInNoProject(threadCount)}. ${failureAdvice(failure, false)}`;
  const kept = `Your files are still in the old folder and ${stillInNoProject(threadCount)}`;
  if (!partialCopyRemoved) return `${kept}. Mcode couldn't remove the partial copy yet; it will try again when it restarts.`;
  return `${kept}; Mcode removed the partial copy. ${failureAdvice(failure, true)}`;
}

function rollbackPendingDetail(folder: string | null): ReactNode {
  return (
    <>
      Mcode couldn't put the folder back.{" "}
      {folder === null ? null : <>Your files are in <BreakablePath path={folder} className="text-ink" />. </>}
      The threads in this folder can't run until Mcode finishes; it will try again when it restarts.
    </>
  );
}

interface MoveFailureNoticeProps {
  readonly failure: FolderMoveFailure;
  /** The name the user gave the project, or "" when there is none to name. */
  readonly projectName: string;
  /** How many threads were in the folder, this one included. */
  readonly threadCount: number;
}

/** What went wrong with the folder move, what is left where, and the server's own words behind a disclosure. */
export function MoveFailureNotice({ failure, projectName, threadCount }: MoveFailureNoticeProps) {
  const folderMoveTitle = projectName === "" ? "Couldn't move the folder" : `Couldn't move the folder to ${projectName}`;
  const title = failure.kind === "failed" && failure.outcome === "rolled-back" ? failedTitle(failure, folderMoveTitle) : folderMoveTitle;
  const detail = failure.kind === "failed" ? failedDetail(failure, threadCount) : rollbackPendingDetail(failure.folder);
  return <Notice tone="error" title={title} detail={detail} more={failure.error} />;
}
