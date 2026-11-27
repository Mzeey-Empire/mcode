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

const FILE_IN_USE = /EBUSY|EPERM|EACCES|resource busy|permission denied|being used by another process/i;

function stillInNoProject(threadCount: number): string {
  return threadCount > 1 ? "the threads are still in No project" : "the thread is still in No project";
}

function unconfirmedDetail(threadCount: number): string {
  return `Mcode could not confirm the move. ${threadCount > 1 ? "The threads stay" : "The thread stays"} in No project here until Mcode hears that it moved.`;
}

function failedDetail(failure: Extract<FolderMoveFailure, { kind: "failed" }>, threadCount: number): string {
  if (failure.outcome === "unconfirmed") return unconfirmedDetail(threadCount);
  const hint = FILE_IN_USE.test(failure.error) ? "Close any app using files in the folder, then try again." : "Try again in a moment.";
  return `Nothing changed: ${stillInNoProject(threadCount)}. ${hint}`;
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
  const title = projectName === "" ? "Couldn't move the folder" : `Couldn't move the folder to ${projectName}`;
  const detail = failure.kind === "failed" ? failedDetail(failure, threadCount) : rollbackPendingDetail(failure.folder);
  return <Notice tone="error" title={title} detail={detail} more={failure.error} />;
}
