/**
 * JSON-RPC 2.0 method dispatch for the Codex browser-use pipe.
 *
 * Pure logic: the router takes a method name + params and returns a result
 * (or throws). Network glue (framing, socket lifecycle) lives in
 * `pipe-server.ts`. This split lets us unit-test the protocol without
 * binding ports or pipes.
 *
 * Method surface mirrors dpcode's `browserUsePipeServer.ts handleRequest`.
 */

import type {
  BrowserCdpEventListener,
  BrowserExecuteCdpRequest,
  BrowserHostBridge,
  BrowserHostSnapshot,
} from "./host-bridge.js";
import { TabIdMap, type TrackedTab } from "./tab-id-map.js";

/** Per-connection / per-session state. */
export interface PipeSessionState {
  selectedTrackedTabIdBySessionId: Map<string, number>;
  cdpListenerDisposeBySessionId: Map<string, () => void>;
}

export function createPipeSessionState(): PipeSessionState {
  return {
    selectedTrackedTabIdBySessionId: new Map(),
    cdpListenerDisposeBySessionId: new Map(),
  };
}

/** Subset of router dependencies; lets tests inject fakes. */
export interface RouterDeps {
  readonly host: BrowserHostBridge;
  readonly tabIds: TabIdMap;
  readonly state: PipeSessionState;
  /** Emit a JSON-RPC notification to every connected client. */
  readonly broadcast: (notification: { method: string; params: unknown }) => void;
  /** Brings the IAB panel into view; resolves when ready. Phase A: no-op stub allowed. */
  readonly ensurePanelOpen: () => Promise<BrowserHostSnapshot | null>;
  /** App version string for getInfo. */
  readonly appVersion: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireSessionId(params: unknown): string {
  const sid = asString(asObject(params)?.session_id);
  if (!sid) throw new Error("Missing required browser session_id");
  return sid;
}

function snapshotRows(
  snapshot: BrowserHostSnapshot,
  tabIds: TabIdMap,
  selectedTrackedTabId: number | null,
) {
  return snapshot.tabs.map((tab) => {
    const tracked = tabIds.track(snapshot.threadId, tab.id);
    return {
      id: tracked.id,
      title: tab.title,
      active:
        selectedTrackedTabId === tracked.id ||
        (selectedTrackedTabId === null && tab.active),
      url: tab.url,
    };
  });
}

function resolveTrackedTabForSession(
  state: PipeSessionState,
  tabIds: TabIdMap,
  sessionId: string,
  params: unknown,
): TrackedTab {
  const requested = asNumber(asObject(params)?.tabId);
  const selected = state.selectedTrackedTabIdBySessionId.get(sessionId) ?? null;
  const id = requested ?? selected;
  if (id === null) throw new Error("No browser tab selected for this session.");
  const tracked = tabIds.byTrackedId(id);
  if (!tracked) throw new Error(`Unknown tab: ${id}`);
  return tracked;
}

/**
 * Dispatches one JSON-RPC method call to the host bridge.
 * Throws on errors; callers map exceptions to JSON-RPC error responses.
 */
export async function handleRpcRequest(
  deps: RouterDeps,
  method: string,
  params: unknown,
): Promise<unknown> {
  const { host, tabIds, state, broadcast, ensurePanelOpen, appVersion } = deps;

  switch (method) {
    case "ping":
      return "pong";

    case "getInfo": {
      const sessionId = asString(asObject(params)?.session_id);
      return {
        name: "Mcode In-app Browser",
        version: appVersion,
        type: "iab",
        ...(sessionId ? { metadata: { codexSessionId: sessionId } } : {}),
      };
    }

    case "getTabs": {
      const sessionId = requireSessionId(params);
      const snapshot = host.getActiveSnapshot();
      if (!snapshot) return [];
      const selected = state.selectedTrackedTabIdBySessionId.get(sessionId) ?? null;
      return snapshotRows(snapshot, tabIds, selected);
    }

    case "createTab": {
      const sessionId = requireSessionId(params);
      // Phase A: createTab requires the panel to be open; we do not have a
      // "open panel" path from the bridge yet, so we rely on the panel
      // already being mounted (matches dpcode's wait-for-panel timeout).
      const snapshot = host.getActiveSnapshot() ?? (await ensurePanelOpen());
      if (!snapshot) {
        throw new Error("No active Mcode browser pane available");
      }
      // Phase A shim: we cannot create a new live tab without per-tab
      // runtimes (Slice 2). Return the active tab as a row so a Codex client
      // that immediately calls executeCdp gets a working target.
      const activeRow = snapshot.tabs.find((t) => t.active) ?? snapshot.tabs[0];
      if (!activeRow) {
        throw new Error("Could not create a browser tab.");
      }
      const tracked = tabIds.track(snapshot.threadId, activeRow.id);
      state.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
      return {
        id: tracked.id,
        title: activeRow.title,
        active: true,
        url: activeRow.url,
      };
    }

    case "nameSession": {
      requireSessionId(params);
      const name = asString(asObject(params)?.name);
      if (!name) throw new Error("nameSession requires a name");
      // Pure ack: we do not yet surface a session name in the UI.
      return {};
    }

    case "attach": {
      const sessionId = requireSessionId(params);
      const tracked = resolveTrackedTabForSession(state, tabIds, sessionId, params);
      state.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);

      // Drop any prior subscription for this session before re-subscribing.
      state.cdpListenerDisposeBySessionId.get(sessionId)?.();

      await host.attachDebugger(tracked.threadId, tracked.tabId);

      const listener: BrowserCdpEventListener = (event) => {
        broadcast({
          method: "onCDPEvent",
          params: {
            source: { tabId: tracked.id },
            method: event.method,
            ...(event.params !== undefined ? { params: event.params } : {}),
          },
        });
      };
      const dispose = host.subscribeCdpEvents(
        { threadId: tracked.threadId, tabId: tracked.tabId },
        listener,
      );
      state.cdpListenerDisposeBySessionId.set(sessionId, dispose);
      return {};
    }

    case "detach": {
      const sessionId = requireSessionId(params);
      state.cdpListenerDisposeBySessionId.get(sessionId)?.();
      state.cdpListenerDisposeBySessionId.delete(sessionId);
      return {};
    }

    case "executeCdp": {
      const sessionId = requireSessionId(params);
      const req = asObject(params);
      const cdpMethod = asString(req?.method);
      if (!cdpMethod) throw new Error("executeCdp requires a method");
      const tracked = resolveTrackedTabForSession(
        state,
        tabIds,
        sessionId,
        asObject(req?.target) ?? null,
      );
      state.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
      const commandParams = asObject(req?.commandParams);
      const input: BrowserExecuteCdpRequest = {
        threadId: tracked.threadId,
        tabId: tracked.tabId,
        method: cdpMethod,
        ...(commandParams ? { params: commandParams } : {}),
      };
      return host.executeCdp(input);
    }

    default:
      throw new Error(`No handler registered for method: ${method}`);
  }
}
