import { useEffect } from "react";
import { create } from "zustand";
import type { BackgroundCommand } from "@mcode/contracts/models/tool-call-record";
import { WS_CHANNELS } from "@mcode/contracts/ws/channels";
import { getTransport, pushEmitter } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";

/** One thread's command list load: a stale load keeps the last good list after a failed refresh. */
export type BackgroundCommandLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly commands: readonly BackgroundCommand[] }
  | { readonly kind: "stale"; readonly commands: readonly BackgroundCommand[] }
  | { readonly kind: "failed" };

const LOADING: BackgroundCommandLoad = { kind: "loading" };

/** The last good command list of a load, if it has one. */
export function commandsOf(load: BackgroundCommandLoad | undefined): readonly BackgroundCommand[] | undefined {
  return load?.kind === "ready" || load?.kind === "stale" ? load.commands : undefined;
}

interface BackgroundCommandState {
  loads: ReadonlyMap<string, BackgroundCommandLoad>;
  ensure: (threadId: string) => Promise<void>;
  refresh: (threadId: string) => Promise<void>;
  clearThread: (threadId: string) => void;
}

const requests = new Map<string, Promise<void>>();
// A push that lands while a load is in flight may describe a change the load already missed.
const reloadAfterRequest = new Set<string>();
let listening = false;

function tracked(threadId: string): boolean {
  return useBackgroundCommandStore.getState().loads.has(threadId) || requests.has(threadId);
}

function listen(): void {
  if (listening) return;
  listening = true;
  pushEmitter.on("backgroundCommand.changed", (payload) => {
    const parsed = WS_CHANNELS["backgroundCommand.changed"].safeParse(payload);
    if (!parsed.success || !tracked(parsed.data.threadId)) return;
    void useBackgroundCommandStore.getState().refresh(parsed.data.threadId);
  });
  pushEmitter.on("thread.deleted", (payload) => {
    const parsed = WS_CHANNELS["thread.deleted"].safeParse(payload);
    if (parsed.success) useBackgroundCommandStore.getState().clearThread(parsed.data.threadId);
  });
  useConnectionStore.subscribe((next, previous) => {
    if (next.status !== "connected" || previous.status === "connected") return;
    const state = useBackgroundCommandStore.getState();
    for (const id of new Set([...state.loads.keys(), ...requests.keys()])) void state.refresh(id);
  });
}

function setLoad(threadId: string, load: (current: BackgroundCommandLoad | undefined) => BackgroundCommandLoad): void {
  useBackgroundCommandStore.setState((state) => {
    // A thread cleared while its load was in flight stays cleared.
    if (!state.loads.has(threadId)) return state;
    return { loads: new Map(state.loads).set(threadId, load(state.loads.get(threadId))) };
  });
}

async function fetchCommands(threadId: string): Promise<void> {
  do {
    reloadAfterRequest.delete(threadId);
    try {
      const commands = await getTransport().listBackgroundCommands(threadId);
      setLoad(threadId, () => ({ kind: "ready", commands }));
    } catch {
      setLoad(threadId, (current) => {
        const commands = commandsOf(current);
        return commands ? { kind: "stale", commands } : { kind: "failed" };
      });
    }
  } while (reloadAfterRequest.has(threadId));
}

/** One running-command list per thread, refreshed by push and reconnect without polling. */
export const useBackgroundCommandStore = create<BackgroundCommandState>((_set, get) => ({
  loads: new Map(),
  ensure: (threadId) => {
    listen();
    return get().loads.has(threadId) ? Promise.resolve() : get().refresh(threadId);
  },
  refresh: (threadId) => {
    listen();
    const pending = requests.get(threadId);
    if (pending) {
      reloadAfterRequest.add(threadId);
      return pending;
    }
    const current = get().loads.get(threadId);
    if (!commandsOf(current)) {
      useBackgroundCommandStore.setState((state) => ({ loads: new Map(state.loads).set(threadId, LOADING) }));
    }
    const request = fetchCommands(threadId).finally(() => requests.delete(threadId));
    requests.set(threadId, request);
    return request;
  },
  clearThread: (threadId) => {
    reloadAfterRequest.delete(threadId);
    if (!get().loads.has(threadId)) return;
    useBackgroundCommandStore.setState((state) => {
      const loads = new Map(state.loads);
      loads.delete(threadId);
      return { loads };
    });
  },
}));

/** Fetch on first mounted use and return the thread's load, `loading` until one starts. */
export function useBackgroundCommandLoad(threadId: string): BackgroundCommandLoad {
  const load = useBackgroundCommandStore((state) => state.loads.get(threadId) ?? LOADING);
  useEffect(() => { void useBackgroundCommandStore.getState().ensure(threadId); }, [threadId]);
  return load;
}
