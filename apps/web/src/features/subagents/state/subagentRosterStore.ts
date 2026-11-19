import { useEffect } from "react";
import { create } from "zustand";
import type { SubagentRoster, SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { WS_CHANNELS } from "@mcode/contracts/ws/channels";
import { getTransport, pushEmitter } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";

/** One parent's roster load: a stale load keeps the last good roster after a failed refresh. */
export type RosterLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly roster: SubagentRoster }
  | { readonly kind: "stale"; readonly roster: SubagentRoster }
  | { readonly kind: "failed" };

const LOADING: RosterLoad = { kind: "loading" };

/** The last good roster of a load, if it has one. */
export function rosterOf(load: RosterLoad | undefined): SubagentRoster | undefined {
  return load?.kind === "ready" || load?.kind === "stale" ? load.roster : undefined;
}

interface RosterState {
  loads: ReadonlyMap<string, RosterLoad>;
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
    if (!state.loads.has(id) && !requests.has(id)) return;
    if (retiredEpochs.get(id)?.has(change.epoch)) return;
    if (!newer(change, wanted.get(id) ?? rosterOf(state.loads.get(id)))) return;
    wanted.set(id, change);
    void state.refresh(id);
  });
  useConnectionStore.subscribe((next, previous) => {
    if (next.status !== "connected" || previous.status === "connected") return;
    const state = useSubagentRosterStore.getState();
    for (const id of new Set([...state.loads.keys(), ...requests.keys()])) {
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
        const previous = rosterOf(state.loads.get(threadId));
        if (previous?.epoch === loaded.epoch && previous.revision > loaded.revision) return state;
        if (previous && previous.epoch !== loaded.epoch) {
          const retired = retiredEpochs.get(threadId) ?? new Set<string>();
          retired.add(previous.epoch);
          retiredEpochs.set(threadId, retired);
        }
        return { loads: new Map(state.loads).set(threadId, { kind: "ready", roster: loaded }) };
      });
      const latest = wanted.get(threadId);
      again = latest !== target && latest !== undefined && newer(latest, loaded);
      if (!again) wanted.delete(threadId);
    } catch {
      if (generation !== reconnectGeneration(threadId)) continue;
      useSubagentRosterStore.setState((state) => ({ loads: new Map(state.loads).set(threadId, failedLoad(state.loads.get(threadId))) }));
      return;
    }
  }
}

function failedLoad(current: RosterLoad | undefined): RosterLoad {
  const roster = rosterOf(current);
  return roster ? { kind: "stale", roster } : { kind: "failed" };
}

function reconnectGeneration(threadId: string): number {
  return reconnects.get(threadId) ?? 0;
}

/** One authoritative roster per parent, refreshed by push and reconnect without polling. */
export const useSubagentRosterStore = create<RosterState>((_set, get) => ({
  loads: new Map(),
  ensure: (threadId) => {
    listen();
    return get().loads.has(threadId) ? Promise.resolve() : get().refresh(threadId);
  },
  refresh: (threadId) => {
    listen();
    const pending = requests.get(threadId);
    if (pending) return pending;
    const current = get().loads.get(threadId);
    if (!rosterOf(current) && current?.kind !== "loading") {
      useSubagentRosterStore.setState((state) => ({ loads: new Map(state.loads).set(threadId, LOADING) }));
    }
    const request = fetchRoster(threadId).finally(() => requests.delete(threadId));
    requests.set(threadId, request);
    return request;
  },
  entryForToolCall: (threadId, toolCallId) =>
    rosterOf(get().loads.get(threadId))?.entries.find((entry) => entry.sourceToolCallId === toolCallId),
}));

/** Fetch on first mounted use and return the thread's load, `loading` until one starts. */
export function useSubagentRosterLoad(threadId: string): RosterLoad {
  const load = useSubagentRosterStore((state) => state.loads.get(threadId) ?? LOADING);
  useEffect(() => { void useSubagentRosterStore.getState().ensure(threadId); }, [threadId]);
  return load;
}

/** Fetch on first mounted use, retaining the last good roster across errors. */
export function useSubagentRoster(threadId: string | undefined): SubagentRoster | undefined {
  const roster = useSubagentRosterStore((state) => threadId ? rosterOf(state.loads.get(threadId)) : undefined);
  useEffect(() => { if (threadId) void useSubagentRosterStore.getState().ensure(threadId); }, [threadId]);
  return roster;
}
