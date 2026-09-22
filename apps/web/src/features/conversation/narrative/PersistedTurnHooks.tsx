import { useMemo } from "react";
import { useThreadRecord } from "@/stores/thread-selectors";
import { recordToHookExecution } from "./build-persisted-narrative";
import { TurnHooksPopover } from "./TurnHooksPopover";

/** Reads hooks for one completed response, including late hooks added to its narrative cache. */
export function PersistedTurnHooks({ threadId, messageId }: { threadId: string; messageId: string }) {
  const records = useThreadRecord(threadId, (record) => record.narrativeByMessage[messageId]);
  const hooks = useMemo(() => records?.hooks.map(recordToHookExecution) ?? [], [records]);
  return <TurnHooksPopover hooks={hooks} />;
}
