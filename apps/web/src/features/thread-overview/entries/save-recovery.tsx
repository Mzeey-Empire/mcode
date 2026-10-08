import { TurnSaveRecovery } from "@/features/conversation/saving/TurnSavingNotice";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { useThreadStore } from "@/stores/threadStore";
import { type Thread } from "@/transport";
import type { TurnSavingStatus } from "@mcode/contracts";

const EMPTY_SAVING_STATUSES: readonly TurnSavingStatus[] = [];

function SaveRecoveryEntry({ thread }: { thread: Thread }) {
  const { open } = useOverviewContext();
  const overviewSavingStatuses = useThreadStore((state) => (
    open ? state.records.get(thread.id)?.savingStatuses ?? EMPTY_SAVING_STATUSES : EMPTY_SAVING_STATUSES
  ));
  return (<TurnSaveRecovery statuses={overviewSavingStatuses} />);
}

/** SaveRecovery block in the thread overview, preserving its existing row position. */
export function SaveRecoveryEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <SaveRecoveryEntry thread={subject.thread} /> : null;
}
