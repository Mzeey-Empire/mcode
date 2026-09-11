import { useEffect, useMemo } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { recordToHookExecution } from "./build-persisted-narrative";
import { TurnHooksPopover } from "./TurnHooksPopover";

/** Reads hooks for one completed response, including late hooks added to its narrative cache. */
export function PersistedTurnHooks({ threadId, messageId }: { threadId: string; messageId: string }) {
  const records = useThreadRecord(threadId, (record) => record.narrativeByMessage[messageId]);
  const load = useThreadStore((state) => state.loadNarrativeForMessage);
  useEffect(() => {
    if (!records) void load(messageId, threadId);
  }, [records, load, messageId, threadId]);
  const hooks = useMemo(() => records?.hooks.map(recordToHookExecution) ?? [], [records]);
  return <TurnHooksPopover hooks={hooks} />;
}
