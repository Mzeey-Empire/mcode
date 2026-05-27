import { useShallow } from "zustand/shallow";
import { useThreadStore } from "./threadStore";
import {
  createEmptyThreadRecord,
  getThreadRecord,
  type ThreadRecord,
} from "./thread-record";

/**
 * Subscribe to one thread's record with shallow equality on the selected slice.
 */
export function useThreadRecord<T>(
  threadId: string | null | undefined,
  selector: (record: ThreadRecord) => T,
): T {
  return useThreadStore(
    useShallow((state) => {
      if (!threadId) return selector(createEmptyThreadRecord());
      return selector(getThreadRecord(state.records, threadId));
    }),
  );
}

/**
 * Subscribe to the active thread's record with shallow equality on the selected slice.
 */
export function useActiveThreadRecord<T>(
  selector: (record: ThreadRecord) => T,
): T {
  return useThreadStore(
    useShallow((state) => {
      const id = state.currentThreadId;
      const record = id ? getThreadRecord(state.records, id) : createEmptyThreadRecord();
      return selector(record);
    }),
  );
}

/** Imperative read of one thread record without subscribing. */
export function readThreadRecord(threadId: string): ThreadRecord {
  return getThreadRecord(useThreadStore.getState().records, threadId);
}

/** Imperative read of the active thread record without subscribing. */
export function readActiveThreadRecord(): ThreadRecord | undefined {
  const { currentThreadId, records } = useThreadStore.getState();
  if (!currentThreadId) return undefined;
  return records.get(currentThreadId);
}
