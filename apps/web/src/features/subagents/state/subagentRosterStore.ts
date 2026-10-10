import { useEffect } from "react";
import { create } from "zustand";
import type { SubagentRoster, SubagentRosterEntry } from "@mcode/contracts";
import { WS_CHANNELS } from "@mcode/contracts";
import { getTransport, pushEmitter } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";

interface RosterState {
  rosters: ReadonlyMap<string, SubagentRoster>;
  errors: ReadonlySet<string>;
  ensure: (threadId: string) => Promise<void>;
  refresh: (threadId: string) => Promise<void>;
  entryForToolCall: (threadId: string, toolCallId: string) => SubagentRosterEntry | undefined;
}

type Version = Pick<SubagentRoster, "epoch" | "revision">;
const requests = new Map<string, Promise<void>>();
const wanted = new Map<string, Version>();
const reconnects = new Map<string, number>();
const retiredEpochs = new Map<string, Set<string>>();
let listening = false;

function newer(incoming: Version, current: Version | undefined): boolean {
  return !current || incoming.epoch !== current.epoch || incoming.revision > current.revision;
}

function listen(): void {
  if (listening) return;
  listening = true;
  pushEmitter.on("subagents.changed", (payload) => {
    const change = WS_CHANNELS["subagents.changed"].parse(payload);
    const state = useSubagentRosterStore.getState();
    const id = change.threadId;
    if (!state.rosters.has(id) && !state.errors.has(id) && !requests.has(id)) return;
    if (retiredEpochs.get(id)?.has(change.epoch)) return;
    if (!newer(change, wanted.get(id) ?? state.rosters.get(id))) return;
    wanted.set(id, change);
    void state.refresh(id);
  });
  useConnectionStore.subscribe((next, previous) => {
    if (next.status !== "connected" || previous.status === "connected") return;
    const state = useSubagentRosterStore.getState();
    for (const id of new Set([...state.rosters.keys(), ...state.errors, ...requests.keys()])) {
      reconnects.set(id, (reconnects.get(id) ?? 0) + 1);
      wanted.delete(id);
      void state.refresh(id);
    }
  });
}

async function fetchRoster(threadId: string): Promise<void> {
  let again = true;
  while (again) {
    const generation = reconnectGeneration(threadId);
    const target = wanted.get(threadId);
    try {
      const loaded = await getTransport().loadSubagentRoster(threadId);
      if (generation !== reconnectGeneration(threadId)) continue;
      if (retiredEpochs.get(threadId)?.has(loaded.epoch)) return;
      useSubagentRosterStore.setState((state) => {
        const previous = state.rosters.get(threadId);
        if (previous?.epoch === loaded.epoch && previous.revision > loaded.revision) return state;
        if (previous && previous.epoch !== loaded.epoch) {
          const retired = retiredEpochs.get(threadId) ?? new Set<string>();
          retired.add(previous.epoch);
          retiredEpochs.set(threadId, retired);
        }
        const rosters = new Map(state.rosters).set(threadId, loaded);
        const errors = new Set(state.errors);
        errors.delete(threadId);
        return { rosters, errors };
      });
      const latest = wanted.get(threadId);
      again = latest !== target && latest !== undefined && newer(latest, loaded);
      if (!again) wanted.delete(threadId);
    } catch {
      if (generation !== reconnectGeneration(threadId)) continue;
      useSubagentRosterStore.setState((state) => ({ errors: new Set(state.errors).add(threadId) }));
      return;
    }
  }
}

function reconnectGeneration(threadId: string): number {
  return reconnects.get(threadId) ?? 0;
}

/** One authoritative roster per parent, refreshed by push and reconnect without polling. */
export const useSubagentRosterStore = create<RosterState>((_set, get) => ({
  rosters: new Map(),
  errors: new Set(),
  ensure: (threadId) => {
    listen();
    return get().rosters.has(threadId) || get().errors.has(threadId)
      ? Promise.resolve() : get().refresh(threadId);
  },
  refresh: (threadId) => {
    listen();
    const pending = requests.get(threadId);
    if (pending) return pending;
    const request = fetchRoster(threadId).finally(() => requests.delete(threadId));
    requests.set(threadId, request);
    return request;
  },
  entryForToolCall: (threadId, toolCallId) =>
    get().rosters.get(threadId)?.entries.find((entry) => entry.sourceToolCallId === toolCallId),
}));

/** Fetch on first mounted use, retaining the last good roster across errors. */
export function useSubagentRoster(threadId: string | undefined): SubagentRoster | undefined {
  const roster = useSubagentRosterStore((state) => threadId ? state.rosters.get(threadId) : undefined);
  useEffect(() => { if (threadId) void useSubagentRosterStore.getState().ensure(threadId); }, [threadId]);
  return roster;
}
