import { BackgroundCommandList } from "@/features/background-commands/BackgroundCommandList";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";

/** Running background commands in the thread overview, beside the Subagents row. */
export function BackgroundCommandsEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <BackgroundCommandList threadId={subject.thread.id} /> : null;
}
