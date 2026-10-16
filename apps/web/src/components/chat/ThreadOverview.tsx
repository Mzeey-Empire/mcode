import { OverviewMount } from "@/features/thread-overview/overview-mount";
import { threadOverviewScope, useOverviewPresentation } from "@/features/thread-overview/overview-presentation";
import {
  OverviewContext,
  OverviewDialogs,
  useOverviewState,
} from "@/features/thread-overview/overview-state";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewStore } from "@/stores/overviewStore";
import { type Thread } from "@/transport";
import { useCallback } from "react";

/** Props for {@link ThreadOverview}. */
interface ThreadOverviewProps {
  thread: Thread;
  /** Width of the chat canvas that contains this thread's timeline and composer. */
  threadPaneWidth: number;
}

/**
 * The thread's Overview: the shared mount plus the Git and dialog state that only a
 * persisted thread has.
 */
export function ThreadOverview({ thread, threadPaneWidth }: ThreadOverviewProps) {
  const scope = threadOverviewScope(thread);
  const presentation = useOverviewPresentation(scope, threadPaneWidth);
  const key = scope.key;
  const closeOverlay = useCallback(() => useOverviewStore.getState().dismissOverlay(key), [key]);
  const state = useOverviewState(thread, presentation.presentation !== "hidden", closeOverlay);
  const subject: OverviewSubject = { kind: "thread", thread };
  return (<OverviewContext.Provider value={state}>
    <OverviewMount subject={subject} subjectKey={key} presentation={presentation} ciDot={state.ciDot}>
      <OverviewDialogs thread={thread} />
    </OverviewMount>
  </OverviewContext.Provider>);
}
