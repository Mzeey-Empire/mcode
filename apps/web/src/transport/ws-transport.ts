import type { DiffStats, ReviewComparison } from "@mcode/contracts";
import type {
  McodeTransport,
  Workspace,
  WorkspaceEnrichment,
  Thread,
  GitBranch,
  BranchComparison,
  WorktreeInfo,
  AttachmentMeta,
  ProviderCatalogRequest,
  ProviderCatalogSnapshot,
  PrInfo,
  PrDetail,
  ToolCallRecord,
  ThoughtSegmentRecord,
  HookExecutionRecord,
  Settings,
  GitCommit,
  ProviderModelInfo,
  CopilotSubagent,
  GitRemoteUrl,
  TerminalPreferencesResult,
  TerminalProfileList,
  TerminalWorkspacePreference,
  WorkspaceEnvironmentReadResult,
  WorkspaceEnvironmentSetupAttempt,
  WorkspaceEnvironmentActionRun,
} from "./types";
import { TurnRuntimeSnapshotSchema, WS_CHANNELS, WS_METHODS } from "@mcode/contracts";
import { TerminalErrorCodeSchema } from "@mcode/contracts";
import type {
  CreateAndSendResult,
  ThreadStartup,
  ThreadStartupListResult,
  PullRequestCapabilitiesRequest,
  PullRequestCapabilitiesResult,
  PullRequestListRequest,
  PullRequestListResult,
  PullRequestGetRequest,
  PullRequestGetResult,
  PullRequestTimelineRequest,
  PullRequestTimelineResult,
  PullRequestFilesRequest,
  PullRequestFilesResult,
  PullRequestPatchRequest,
  PullRequestPatchResult,
  PullRequestCancelRequest,
  PullRequestCancelResult,
  PullRequestCreateReviewTaskRequest,
  PullRequestCreateReviewTaskResult,
  PullRequestReviewLinkRequest,
  PullRequestReviewLinkResult,
  PullRequestPostCommentRequest,
  PullRequestPostCommentResult,
  PullRequestSubmitReviewRequest,
  PullRequestSubmitReviewResult,
  PullRequestSetReadinessRequest,
  PullRequestSetReadinessResult,
  PullRequestCloseRequest,
  PullRequestCloseResult,
  PullRequestMergeRequest,
  PullRequestMergeResult,
  BrowserAutomationHostRegistration,
  BrowserAutomationHostDispatchTarget,
  BrowserAutomationResponse,
  SendMessageInput,
  CreateAndSendInput,
  TerminalBackendCapabilities,
  TerminalDiagnosticsBundle,
  TerminalCustomProfile,
  TerminalProfileReference,
} from "@mcode/contracts";
import type { PaginatedMessages, ConversationPage, ConversationNewerPage, ConversationNewerPageRequest, ConversationOlderPage, ConversationOlderPageRequest, ConversationTail, CanonicalSubagentRoster, CanonicalSubagentStopResult, SetThreadSubscriptionsInput, SetThreadSubscriptionsResult, TurnSnapshot, PrDraft, CreatePrResult, ProviderUsageInfo, ChecksStatus, ProviderAvailability, GoalLookupResult } from "@mcode/contracts";
import {
  TERMINAL_DATA_TAG,
  TERMINAL_BINARY_MAGIC,
  decodeTerminalDataFrame,
} from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import type { PermissionRequest } from "@mcode/contracts";
import { setAttachmentTransportWsUrl } from "@/lib/attachment-url";
import { TerminalClientSelector } from "@/features/terminal/adapters/terminal-client-selector";
import type {
  TerminalActiveSession,
  TerminalClient,
  TerminalClientSubscription,
} from "@/features/terminal/adapters/terminal-client";
import { TerminalRpcError } from "./terminal-rpc-error";

/** Minimum reconnect delay in milliseconds. */
const MIN_RECONNECT_MS = 1000;
/** Maximum reconnect delay in milliseconds. */
const MAX_RECONNECT_MS = 30_000;
/** Number of immediate (delay=0) retries on auth failure before falling back to exponential backoff. */
const MAX_IMMEDIATE_AUTH_RETRIES = 3;
/** Deadline for model discovery requested from the visible model picker. */
const PROVIDER_MODEL_LIST_TIMEOUT_MS = 10_000;
/** Deadline for choosing the Terminal backend before Terminal UI can continue. */
const TERMINAL_CAPABILITIES_TIMEOUT_MS = 10_000;
/** Deadline for a user-requested Terminal creation. */
const TERMINAL_CREATE_TIMEOUT_MS = 20_000;
/** Deadline for closing a Terminal returned after its create request timed out. */
const TERMINAL_LATE_CREATE_CLEANUP_TIMEOUT_MS = 10_000;
/** Maximum Terminal creates whose late responses still need exact cleanup. */
const MAX_PENDING_TERMINAL_CREATE_CLEANUPS = 8;

/** Last thread-list refresh timestamp per workspace, triggered on WS reconnect. */
const lastLoadThreadsAtByWorkspace = new Map<string, number>();
/** Minimum interval between reconnect-triggered thread-list fetches to avoid rapid-reconnect storms. */
const LOAD_THREADS_RECONNECT_COOLDOWN_MS = 5_000;

/** Minimum interval between desktop ensure-server-running requests. */
const ENSURE_SERVER_THROTTLE_MS = 15_000;
/** Timestamp of the last ensure-server-running request (module-level: one server per app). */
let lastEnsureServerAt = 0;

/**
 * Ask the Electron main process to verify (and silently restart) the server.
 * Throttled so rapid reconnect attempts do not stack health checks. No-op in
 * browser builds where `desktopBridge` is absent.
 *
 * Returns whether a request was actually issued. Exported for unit testing.
 */
export function requestEnsureServerRunning(now: number = Date.now()): boolean {
  if (now - lastEnsureServerAt < ENSURE_SERVER_THROTTLE_MS) return false;
  lastEnsureServerAt = now;
  if (typeof window === "undefined") return false;
  void window.desktopBridge?.ensureServerRunning?.()?.catch(() => {
    // Best-effort: reconnect backoff continues regardless.
  });
  return true;
}

/** Reset the ensure-server throttle. Test-only. */
export function resetEnsureServerThrottleForTest(): void {
  lastEnsureServerAt = 0;
}

/** Structured error returned by an RPC method, including typed error data. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly data?: Record<string, unknown>,
    readonly retry?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface RpcErrorDetails {
  readonly code: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
  readonly retry?: string;
}

function toTransportRpcError(error: unknown): Error {
  if (isTerminalRpcError(error)) return new TerminalRpcError(error);
  const details = readRpcErrorDetails(error);
  return new RpcError(details.message, details.code, details.data, details.retry);
}

function isTerminalRpcError(error: unknown): boolean {
  return isRecord(error) && TerminalErrorCodeSchema().safeParse(error.code).success;
}

function readRpcErrorDetails(error: unknown): RpcErrorDetails {
  if (!isRecord(error)) return { code: "RPC_ERROR", message: "RPC error" };
  const code = typeof error.code === "string" ? error.code : "RPC_ERROR";
  const message = typeof error.message === "string" ? error.message : "RPC error";
  const retry = typeof error.retry === "string" ? error.retry : undefined;
  const data = isRecord(error.data) ? error.data : undefined;
  return data ? { code, message, data, retry } : { code, message, retry };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Listener = (data: unknown) => void;

/**
 * Minimal event emitter for push channel subscriptions.
 * Components subscribe via `on()` and receive server-pushed payloads.
 */
export class PushEmitter {
  private listeners = new Map<string, Set<Listener>>();

  /** Subscribe to a push channel. Returns an unsubscribe function. */
  on(channel: string, fn: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(channel);
    };
  }

  /** Emit a payload to all listeners on a channel. */
  emit(channel: string, data: unknown): void {
    const set = this.listeners.get(channel);
    if (set) {
      for (const fn of set) {
        try {
          fn(data);
        } catch (err) {
          console.error(`[PushEmitter] Error in listener for "${channel}":`, err);
        }
      }
    }
  }

  /** Return the set of channels that have at least one listener. */
  channels(): string[] {
    return [...this.listeners.keys()];
  }
}

/** Singleton push emitter shared between ws-transport and ws-events. */
export const pushEmitter = new PushEmitter();

/**
 * Channels suppressed from WebSocket push delivery.
 * When a MessagePort handles a channel, it adds the channel name here
 * so WebSocket push messages for that channel are silently dropped.
 */
export const suppressedPushChannels = new Set<string>();

/**
 * Last seq number seen per ptyId.
 * Updated by TerminalView on each received PTY data frame and read by the
 * reconnect handler to call terminal.reattach with the correct lastSeq.
 */
export const ptyLastSeqMap = new Map<string, number>();

/** Resolves the selected Terminal session in the currently active panel scope. */
export function resolveSelectedTerminalId(input: {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly terminalPanelByThread: Readonly<
    Record<string, { readonly activeTerminalId: string | null }>
  >;
}): string | null {
  const scopeId = input.activeThreadId ?? input.activeWorkspaceId;
  return scopeId ? input.terminalPanelByThread[scopeId]?.activeTerminalId ?? null : null;
}

/** Returns whether reconnect may reattach the selected Terminal session for replay. */
export function shouldReattachSelectedTerminal(
  session: Pick<TerminalActiveSession, "ptyId" | "state">,
  selectedTerminalId: string | null,
): boolean {
  return session.ptyId === selectedTerminalId &&
    (session.state === "running" || session.state === "starting" ||
      session.state === "exited" || session.state === "failed");
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface LateResponseHandler {
  readonly onSuccess?: (result: unknown) => void;
  readonly onSettled?: () => void;
}

interface RpcOptions {
  /** Bound this request without changing the transport's default timeout. */
  readonly timeoutMs?: number;
  /** Reclaims a resource when a timed-out request eventually succeeds. */
  readonly onLateSuccess?: (result: unknown) => void;
  /** Runs request-specific cleanup after a late response settles. */
  readonly onLateSettled?: () => void;
  /** Rejects a request before it consumes transport state. */
  readonly rejectBeforeRequest?: () => Error | null;
  /** Releases request-specific state after a normal response or failure. */
  readonly onRequestSettled?: () => void;
}

/** Raised when a request for an interactive control exceeds its bounded wait. */
export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super("Request timed out. Try again.");
    this.name = "RpcTimeoutError";
  }
}

/** Extracts the exact Terminal ID from a late successful create response. */
export function parseLateTerminalCreateId(
  method: "terminal.create" | "terminal.session.create",
  result: unknown,
): string | null {
  if (method === "terminal.create") {
    const parsed = WS_METHODS()["terminal.create"].result.safeParse(result);
    return parsed.success ? readTerminalCreateId(parsed.data, "ptyId") : null;
  }
  const parsed = WS_METHODS()["terminal.session.create"].result.safeParse(result);
  return parsed.success ? readTerminalCreateId(parsed.data, "sessionId") : null;
}

function readTerminalCreateId(value: unknown, field: "ptyId" | "sessionId"): string | null {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, field)) return null;
  const id = Reflect.get(value, field);
  return typeof id === "string" ? id : null;
}

/** Describes the current state of the WebSocket connection. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "authFailed";

/** Options for configuring `createWsTransport` behavior. */
export interface WsTransportOptions {
  /** Called whenever the connection status changes. */
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Called between reconnect attempts to refresh the server URL. */
  discoverServerUrl?: () => Promise<string>;
}

/**
 * Reconcile runningThreadIds with the server's authoritative set on (re)connect.
 *
 * Race-safe: captures each optimistic runtime identity before the RPC and
 * applies the response only to threads that have not advanced while it was
 * in flight. Unchanged stale threads are dropped; newer push state wins.
 *
 * Exported for unit testing.
 */
export async function hydrateRunningThreadsFromServer(
  rpcCall: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  const beforeHydration = useThreadStore.getState();
  const observed = new Map(
    [...beforeHydration.runningThreadIds].map((threadId) => {
      const record = beforeHydration.records.get(threadId);
      return [threadId, {
        turnExecutionId: record?.turnExecutionId ?? null,
        runtimePhase: record?.runtimePhase ?? "idle",
      }] as const;
    }),
  );
  try {
    const result = await rpcCall("agent.listRunning", {});
    const snapshots = TurnRuntimeSnapshotSchema().array().parse(result);
    useThreadStore.getState().hydrateThreadRuntimes(snapshots, observed);
  } catch {
    // Best-effort; optimistic state remains if the call fails.
  }
}

/**
 * Create a WebSocket-based transport that implements `McodeTransport`.
 *
 * Every method maps to a single JSON-RPC call matching the server's
 * `WS_METHODS` names. Server push messages are forwarded to `pushEmitter`.
 *
 * Includes automatic reconnection with exponential backoff and
 * re-subscription to push channels on reconnect.
 */
export function createWsTransport(
  initialUrl: string,
  options?: WsTransportOptions,
): McodeTransport & { close(): void; waitForConnection(timeoutMs: number): Promise<void> } {
  let url = initialUrl;
  let ws: WebSocket;
  let idCounter = 0;
  let pending = new Map<string, PendingCall>();
  let lateResponseHandlers = new Map<string, LateResponseHandler>();
  // Each reservation holds a terminal create until it either resolves or its
  // late response can clean up the unknown terminal. The cap bounds a stalled
  // server while allowing normal retries after one visible timeout.
  const pendingTerminalCreateCleanups = new Set<symbol>();
  const freshTurnDiffThreads = new Set<string>();
  let closed = false;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalSelectionPromise: Promise<TerminalBackendCapabilities> | null = null;
  // Track consecutive auth failures so we apply backoff after 3 immediate
  // retries, preventing a tight loop when the token is persistently wrong.
  let consecutiveAuthFailures = 0;

  async function reattachTerminalSession(
    terminalClient: TerminalClient,
    session: TerminalActiveSession,
  ): Promise<void> {
    // -1 means "I have seen nothing" — server replays everything including seq=0.
    const lastSeq = ptyLastSeqMap.get(session.ptyId) ?? -1;
    const result = await terminalClient.reattach(session.ptyId, lastSeq);
    if (result.mode === "reset") {
      ptyLastSeqMap.set(session.ptyId, result.discardThrough);
      terminalClient.notifyReconnectGap(session.ptyId);
      return;
    }
    if (result.mode === "checkpoint") {
      ptyLastSeqMap.set(session.ptyId, result.checkpointThrough);
    }
  }

  async function reattachActiveTerminals(): Promise<void> {
    await terminalSelectionPromise;
    const terminalClient = terminalClientSelector.getSelected();
    const activePtys = await terminalClient.listActive();
    const [terminalStoreModule, workspaceStoreModule] = await Promise.all([
      import("@/features/terminal/state/terminalStore"),
      import("@/features/projects/state/workspaceStore"),
    ]);
    terminalStoreModule.useTerminalStore.getState().reconcileActiveSessions(activePtys);
    const terminalState = terminalStoreModule.useTerminalStore.getState();
    const workspaceState = workspaceStoreModule.useWorkspaceStore.getState();
    const selectedTerminalId = resolveSelectedTerminalId({
      activeThreadId: workspaceState.activeThreadId,
      activeWorkspaceId: workspaceState.activeWorkspaceId,
      terminalPanelByThread: terminalState.terminalPanelByThread,
    });
    const selectedSessions = activePtys.filter((session) =>
      shouldReattachSelectedTerminal(session, selectedTerminalId),
    );
    await Promise.allSettled(
      selectedSessions.map((session) => reattachTerminalSession(terminalClient, session)),
    );
  }

  /** Resolves when the current WebSocket connection is open. */
  let ready: Promise<void>;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (err: Error) => void = () => undefined;
  let readyPending = false;

  function resetReady() {
    // A still-pending promise may have rpc() calls parked on it; replacing it
    // would strand them forever.
    if (readyPending) return;
    readyPending = true;
    ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => {
        readyPending = false;
        resolve();
      };
      rejectReady = (err) => {
        readyPending = false;
        reject(err);
      };
    });
    // Rejection is consumed by rpc() awaiters; this swallows it when close()
    // settles `ready` with no one parked on it.
    ready.catch(() => {});
  }

  function emitTerminalDataFrame(view: Uint8Array): void {
    try {
      const decoded = decodeTerminalDataFrame(view);
      if (!suppressedPushChannels.has("terminal.data")) {
        pushEmitter.emit("terminal.data", decoded);
      }
    } catch (error) {
      console.warn("[ws] failed to decode terminal.data frame", error);
    }
  }

  function handleBinaryMessage(data: ArrayBuffer): void {
    const view = new Uint8Array(data);
    if (view[0] === TERMINAL_BINARY_MAGIC[0] && view[1] === TERMINAL_BINARY_MAGIC[1]) {
      terminalClientSelector.handleFrame(view);
      return;
    }
    if (view[0] === TERMINAL_DATA_TAG) {
      emitTerminalDataFrame(view);
      return;
    }
    console.warn("[ws] unknown binary tag 0x" + view[0]?.toString(16));
  }

  function parseSocketMessage(data: string): Record<string, unknown> | null {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  function handleRpcResponse(message: Record<string, unknown>): boolean {
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) return false;
    const call = pending.get(id);
    return call
      ? settlePendingRpcResponse(id, call, message)
      : settleLateRpcResponse(id, message);
  }

  function settlePendingRpcResponse(
    id: string,
    call: PendingCall,
    message: Record<string, unknown>,
  ): true {
    pending.delete(id);
    if (message.error) call.reject(toTransportRpcError(message.error));
    else call.resolve(message.result);
    return true;
  }

  function settleLateRpcResponse(id: string, message: Record<string, unknown>): boolean {
    const handler = lateResponseHandlers.get(id);
    if (!handler) return false;
    lateResponseHandlers.delete(id);
    try {
      if (!message.error) handler.onSuccess?.(message.result);
    } finally {
      handler.onSettled?.();
    }
    return true;
  }

  function emitPushMessage(message: Record<string, unknown>): void {
    if (message.type !== "push") return;
    const channel = message.channel as string;
    if (channel === "turn.diffChanged") {
      const parsed = WS_CHANNELS["turn.diffChanged"].safeParse(message.data);
      if (parsed.success) freshTurnDiffThreads.add(parsed.data.threadId);
    }
    if (!suppressedPushChannels.has(channel)) pushEmitter.emit(channel, message.data);
  }

  function handleSocketMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      handleBinaryMessage(data);
      return;
    }
    const message = parseSocketMessage(data as string);
    if (!message || handleRpcResponse(message)) return;
    emitPushMessage(message);
  }

  function connect(targetUrl?: string) {
    freshTurnDiffThreads.clear();
    resetReady();
    ws = new WebSocket(targetUrl ?? url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      reconnectDelay = MIN_RECONNECT_MS;
      consecutiveAuthFailures = 0;
      setAttachmentTransportWsUrl(url);
      resolveReady();
      options?.onStatusChange?.("connected");
      invalidateLiveTurnDiff();
      void selectTerminalClientWithRecovery();

      // Reconcile runningThreadIds with the server's authoritative set.
      // The client-side optimistic Set is lost on reload/reconnect; this
      // restores live-session indicators for threads the server is still running.
      const hydration = hydrateRunningThreadsFromServer((method, params) => rpc(method, params as Record<string, unknown>));

      // Expose a sentinel in dev/test builds so Playwright can synchronize on
      // hydration completion before injecting agent events. Without this, tests
      // that call handleAgentEvent too early see their optimistic threadIds
      // classified as "pre-hydration" state and wiped by the server's response.
      if (import.meta.env.DEV && typeof window !== "undefined") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__mcodeHydrationComplete = false;
        hydration.finally(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__mcodeHydrationComplete = true;
        });
      }

      // Re-fetch the thread list after reconnect so thread statuses are not
      // stale. A server restart marks active threads "interrupted" in the DB
      // but the client still holds the pre-restart status in memory.
      // Throttled to avoid hammering the API during rapid reconnect cycles
      // (e.g. flaky networks, server restarts causing multiple reconnect attempts).
      // Deferred import avoids a circular dependency at module evaluation time.
      const nowForThreads = Date.now();
      import("@/features/projects/state/workspaceStore").then(({ useWorkspaceStore }) => {
        const { activeWorkspaceId, loadThreads, refreshActiveConversation } = useWorkspaceStore.getState();
        if (!activeWorkspaceId) return;
        const last = lastLoadThreadsAtByWorkspace.get(activeWorkspaceId) ?? 0;
        if (nowForThreads - last <= LOAD_THREADS_RECONNECT_COOLDOWN_MS) {
          void refreshActiveConversation().catch(() => {});
          return;
        }
        lastLoadThreadsAtByWorkspace.set(activeWorkspaceId, nowForThreads);
        loadThreads(activeWorkspaceId)
          .then(() => refreshActiveConversation())
          .catch(() => {});
      });

      // Rehydrate every retained coordination projection from canonical server
      // state after reconnect; in-flight reads are epoch-checked by the store.
      import("@/stores/threadControlStore").then(({ useThreadControlStore }) => {
        void useThreadControlStore.getState().rehydrate();
      });

      // Reattach active terminals after reconnect.
      // Deferred import avoids a circular dependency at module evaluation time.
      void reattachActiveTerminals().catch(() => {
        // Best-effort; terminal output from the gap window is already lost.
      });
    };

    ws.onmessage = (event) => handleSocketMessage(event.data);

    ws.onclose = (event: CloseEvent) => {
      freshTurnDiffThreads.clear();
      rejectPending("WebSocket disconnected");
      lateResponseHandlers = new Map();
      pendingTerminalCreateCleanups.clear();
      invalidateLiveTurnDiff();
      if (!closed) {
        // Re-arm `ready` so rpc() calls park until the reconnect opens instead
        // of sending on a dead socket.
        resetReady();
        const isAuthFailure = event.code === 4001;
        options?.onStatusChange?.(isAuthFailure ? "authFailed" : "reconnecting");
        scheduleReconnect(isAuthFailure);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror; no extra handling needed.
    };
  }

  function rejectPending(reason: string) {
    for (const { reject } of pending.values()) {
      reject(new Error(reason));
    }
    pending = new Map();
  }

  function invalidateLiveTurnDiff(): void {
    void Promise.all([import("@/features/projects/state/workspaceStore"), import("@/stores/diffStore")]).then(([workspace, diff]) => {
      const threadId = workspace.useWorkspaceStore.getState().activeThreadId;
      if (threadId) diff.useDiffStore.getState().bumpDiffRevision(threadId);
    });
  }

  function scheduleReconnect(immediate = false) {
    if (reconnectTimer) return;

    // Non-auth disconnects may mean the server died (e.g. killed during OS
    // sleep). Ask the desktop main process to health-check and self-heal it;
    // throttled so backoff retries do not stack requests.
    if (!immediate) {
      requestEnsureServerRunning();
    }

    // Auth failures use immediate reconnect (delay=0) for the first
    // MAX_IMMEDIATE_AUTH_RETRIES attempts, then fall back to normal backoff
    // to avoid a tight loop when the token is persistently wrong.
    const useImmediate = immediate && consecutiveAuthFailures < MAX_IMMEDIATE_AUTH_RETRIES;
    // Cap the counter so it does not grow unboundedly past the threshold.
    if (immediate && consecutiveAuthFailures < MAX_IMMEDIATE_AUTH_RETRIES) consecutiveAuthFailures++;
    const delay = useImmediate ? 0 : reconnectDelay;

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      // Increase backoff for connectivity failures and for auth failures that
      // have exceeded the immediate-retry limit.
      if (!useImmediate) {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
      }
      if (options?.discoverServerUrl) {
        try {
          const newUrl = await options.discoverServerUrl();
          url = newUrl;
        } catch {
          // Discovery failed, retry with current URL
        }
      }
      // close() cannot cancel a callback already awaiting discovery; bail so a
      // new socket (and a fresh `ready` promise) is not created after dispose.
      if (closed) return;
      connect();
    }, delay);
  }

  /** Send a JSON-RPC request and return the result. */
  function rpc<T>(
    method: string,
    params: Record<string, unknown>,
    options?: RpcOptions,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const immediateError = options?.rejectBeforeRequest?.();
      if (immediateError) {
        reject(immediateError);
        return;
      }
      let settled = false;
      let requestId: string | null = null;
      const deadline = options?.timeoutMs === undefined
        ? null
        : setTimeout(() => {
          if (settled) return;
          settled = true;
          if (requestId) pending.delete(requestId);
          if (requestId && options.onLateSuccess) {
            lateResponseHandlers.set(requestId, {
              onSuccess: options.onLateSuccess,
              onSettled: options.onLateSettled,
            });
          } else {
            options?.onRequestSettled?.();
          }
          reject(new RpcTimeoutError(method));
        }, options.timeoutMs);
      const complete = (value: unknown) => {
        if (settled) return;
        settled = true;
        if (deadline !== null) clearTimeout(deadline);
        options?.onRequestSettled?.();
        resolve(value as T);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (deadline !== null) clearTimeout(deadline);
        options?.onRequestSettled?.();
        reject(error);
      };

      void ready.then(
        () => {
          if (settled) return;
          // `ready` may have resolved on a socket that closed before this
          // continuation ran; send() on a dead socket is silently dropped and the
          // request would sit in `pending` forever.
          if (ws.readyState !== WebSocket.OPEN) {
            fail(new Error("WebSocket disconnected"));
            return;
          }
          requestId = `req_${++idCounter}`;
          pending.set(requestId, { resolve: complete, reject: fail });
          try {
            ws.send(JSON.stringify({ id: requestId, method, params }));
          } catch (error) {
            pending.delete(requestId);
            fail(error instanceof Error ? error : new Error("WebSocket send failed"));
          }
        },
        (error: Error) => fail(error),
      );
    });
  }

  const terminalClientSelector = new TerminalClientSelector(
    <T>(method: string, params: Record<string, unknown>) =>
      rpc<T>(method, params, terminalRpcOptions(method)),
    (frame) => {
      // Drop terminal frames while the socket is down; reattach resyncs output.
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    },
    async (scopeId) => {
      const { useWorkspaceStore } = await import("@/features/projects/state/workspaceStore");
      const state = useWorkspaceStore.getState();
      const thread = state.threads.find((candidate) => candidate.id === scopeId);
      if (thread) return { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id };
      if (state.workspaces.some((workspace) => workspace.id === scopeId)) {
        return { kind: "workspace", workspaceId: scopeId };
      }
      throw new Error("Terminal scope is unavailable");
    },
  );

  function terminalRpcOptions(method: string): RpcOptions | undefined {
    if (method !== "terminal.create" && method !== "terminal.session.create") {
      return undefined;
    }
    const cleanupReservation = Symbol();
    return {
      timeoutMs: TERMINAL_CREATE_TIMEOUT_MS,
      onLateSuccess: (result) => cleanupLateTerminalCreate(method, result),
      onLateSettled: () => {
        pendingTerminalCreateCleanups.delete(cleanupReservation);
      },
      rejectBeforeRequest: () => {
        if (pendingTerminalCreateCleanups.size >= MAX_PENDING_TERMINAL_CREATE_CLEANUPS) {
          return new Error("Too many terminal creations are awaiting cleanup. Try again shortly.");
        }
        pendingTerminalCreateCleanups.add(cleanupReservation);
        return null;
      },
      onRequestSettled: () => {
        pendingTerminalCreateCleanups.delete(cleanupReservation);
      },
    };
  }

  function cleanupLateTerminalCreate(method: string, result: unknown): void {
    if (method !== "terminal.create" && method !== "terminal.session.create") return;
    const terminalId = parseLateTerminalCreateId(method, result);
    if (!terminalId) return;
    const reportCleanupFailure = (error: unknown) => {
      console.warn("[terminal] Could not clean up a terminal created after its request timed out", error);
    };
    if (method === "terminal.create") {
      void rpc<void>("terminal.kill", { ptyId: terminalId }, {
        timeoutMs: TERMINAL_LATE_CREATE_CLEANUP_TIMEOUT_MS,
      }).catch(reportCleanupFailure);
      return;
    }
    void rpc<void>("terminal.session.close", {
      sessionId: terminalId,
      reason: "user",
    }, {
      timeoutMs: TERMINAL_LATE_CREATE_CLEANUP_TIMEOUT_MS,
    }).catch(reportCleanupFailure);
  }

  async function selectTerminalClient(): Promise<TerminalBackendCapabilities> {
    const capabilities = await rpc<TerminalBackendCapabilities>("terminal.capabilities", {}, {
      timeoutMs: TERMINAL_CAPABILITIES_TIMEOUT_MS,
    });
    terminalClientSelector.select(capabilities);
    return capabilities;
  }

  function selectTerminalClientWithRecovery(): Promise<TerminalBackendCapabilities> {
    const selection = selectTerminalClient();
    terminalSelectionPromise = selection;
    void selection.catch(() => {
      if (terminalSelectionPromise === selection) terminalSelectionPromise = null;
    });
    return selection;
  }

  async function terminalCapabilities(): Promise<TerminalBackendCapabilities> {
    return terminalSelectionPromise ?? selectTerminalClientWithRecovery();
  }

  async function withTerminalClient<T>(
    operation: (client: TerminalClient) => Promise<T>,
  ): Promise<T> {
    await terminalCapabilities();
    return operation(terminalClientSelector.getSelected());
  }

  /**
   * Send a binary payload via WebSocket with a JSON header for correlation.
   * 1. Sends a JSON text frame with upload metadata and request ID
   * 2. Immediately sends the binary data as a binary frame
   * 3. Server matches the binary frame to the header and responds on the same ID
   */
  async function rpcBinary<T>(
    method: string,
    meta: Record<string, unknown>,
    payload: ArrayBuffer,
  ): Promise<T> {
    await ready;
    return new Promise<T>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket disconnected"));
        return;
      }
      const id = `req_${++idCounter}`;
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        // Step 1: Send JSON header
        ws.send(JSON.stringify({ type: "binary-upload", id, method, meta }));
        // Step 2: Send binary payload
        ws.send(payload);
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Wait for the WebSocket to establish a connection, or reject if
   * the timeout elapses first.
   */
  function waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const displayUrl = url.split("?")[0];
        reject(new Error(`Could not connect to server at ${displayUrl}`));
      }, timeoutMs);

      ready.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // Kick off the first connection.
  connect();

  return {
    waitForConnection,
    registerBrowserAutomationHost: (registration: BrowserAutomationHostRegistration) =>
      rpc<{ generation: number; desktopInstanceId: string }>(
        "browserAutomation.host.register",
        { registration },
      ),
    updateBrowserAutomationHostTargets: (
      hostId: string,
      generation: number,
      targets: readonly BrowserAutomationHostDispatchTarget[],
    ) => rpc<void>("browserAutomation.host.updateTargets", { hostId, generation, targets }),
    respondToBrowserAutomationRequest: (
      hostId: string,
      generation: number,
      response: BrowserAutomationResponse,
      target?: BrowserAutomationHostDispatchTarget,
    ) => rpc<void>("browserAutomation.host.respond", {
      hostId,
      generation,
      response,
      ...(target ? { target } : {}),
    }),
    heartbeatBrowserAutomationHost: (
      hostId: string,
      generation: number,
      observedAt: number,
    ) => rpc<void>("browserAutomation.host.heartbeat", { hostId, generation, observedAt }),
    cancelBrowserAutomationRequest: (
      hostId: string,
      generation: number,
      requestId: string,
      sequence: number,
      reason: "human-interrupted" | "user-stopped" | "host-shutdown",
    ) => rpc<void>("browserAutomation.host.cancel", {
      hostId,
      generation,
      requestId,
      sequence,
      reason,
    }),
    // Workspace
    listWorkspaces: () => rpc<Workspace[]>("workspace.list", {}),
    createWorkspace: (name, path) => rpc<Workspace>("workspace.create", { name, path }),
    renameWorkspace: (id, name) => rpc<Workspace>("workspace.rename", { id, name }),
    readWorkspaceEnvironment: (workspaceId, threadId) =>
      rpc<WorkspaceEnvironmentReadResult>("workspace.environment.read", { workspaceId, threadId }),
    saveWorkspaceEnvironment: (workspaceId, document, sourceRevision, threadId) =>
      rpc<WorkspaceEnvironmentReadResult>("workspace.environment.save", {
        workspaceId,
        threadId,
        document,
        sourceRevision,
      }),
    setWorkspaceEnvironmentStorageMode: (workspaceId, storageMode, threadId) =>
      rpc<WorkspaceEnvironmentReadResult>("workspace.environment.storage.set", { workspaceId, storageMode, threadId }),
    approveWorkspaceEnvironmentCommand: (threadId, target, fingerprint) =>
      rpc<void>("workspace.environment.command.approve", { threadId, target, fingerprint }),
    clearWorkspaceEnvironmentApprovals: (workspaceId) =>
      rpc<void>("workspace.environment.command.clearApprovals", { workspaceId }),
    startWorkspaceSetup: (threadId) =>
      rpc<WorkspaceEnvironmentSetupAttempt>("workspace.environment.setup.start", { threadId }),
    getWorkspaceSetupAttempt: async (threadId) =>
      (await rpc<{ attempt: WorkspaceEnvironmentSetupAttempt | null }>(
        "workspace.environment.setup.get",
        { threadId },
      )).attempt,
    getAutomaticSetup: (threadId) =>
      rpc<import("@mcode/contracts").WorkspaceEnvironmentAutomaticSetupSnapshot>(
        "workspace.environment.automaticSetup.get",
        { threadId },
      ),
    continueAutomaticSetup: (threadId) =>
      rpc<import("@mcode/contracts").WorkspaceEnvironmentAutomaticSetupSnapshot>(
        "workspace.environment.automaticSetup.continue",
        { threadId },
      ),
    cancelQueuedAutomaticTurn: (threadId, queuedTurnId) =>
      rpc<import("@mcode/contracts").WorkspaceEnvironmentAutomaticSetupSnapshot>(
        "workspace.environment.automaticSetup.cancelQueuedTurn",
        { threadId, queuedTurnId },
      ),
    stopAutomaticSetup: (threadId) =>
      rpc<import("@mcode/contracts").WorkspaceEnvironmentAutomaticSetupSnapshot>(
        "workspace.environment.automaticSetup.stop",
        { threadId },
      ),
    retryAutomaticSetup: (threadId) =>
      rpc<import("@mcode/contracts").WorkspaceEnvironmentAutomaticSetupSnapshot>(
        "workspace.environment.automaticSetup.retry",
        { threadId },
      ),
    openAutomaticSetupTerminal: (threadId) =>
      rpc<import("@mcode/contracts").WorkspaceEnvironmentAutomaticSetupTerminal>(
        "workspace.environment.automaticSetup.openTerminal",
        { threadId },
      ),
    listWorkspaceActionRuns: async (threadId) =>
      (await rpc<{ runs: WorkspaceEnvironmentActionRun[] }>(
        "workspace.environment.action.list",
        { threadId },
      )).runs,
    startWorkspaceAction: (threadId, actionId) =>
      rpc<WorkspaceEnvironmentActionRun>("workspace.environment.action.start", { threadId, actionId }),
    stopWorkspaceAction: async (threadId, actionId) =>
      (await rpc<{ run: WorkspaceEnvironmentActionRun | null }>(
        "workspace.environment.action.stop",
        { threadId, actionId },
      )).run,
    restartWorkspaceAction: (threadId, actionId) =>
      rpc<WorkspaceEnvironmentActionRun>("workspace.environment.action.restart", { threadId, actionId }),
    getWorkspaceActionRun: async (threadId, actionId) =>
      (await rpc<{ run: WorkspaceEnvironmentActionRun | null }>(
        "workspace.environment.action.get",
        { threadId, actionId },
      )).run,
    deleteWorkspace: (id) => rpc<boolean>("workspace.delete", { id }),
    touchLastOpened: (id) => rpc<void>("workspace.touchLastOpened", { id }),
    reorderWorkspace: (id, newIndex) =>
      rpc<void>("workspace.reorder", { id, newIndex }),
    pinWorkspace: (id, pinned) => rpc<void>("workspace.pin", { id, pinned }),
    removeRecent: (id) => rpc<void>("workspace.removeRecent", { id }),
    enrichWorkspaces: (ids) =>
      rpc<{ items: WorkspaceEnrichment[] }>("workspace.enrich", { ids }),
    filesystemBrowse: (path) =>
      rpc<{
        path: string;
        parent: string | null;
        entries: { name: string; isDir: boolean }[];
        isExactDirectory: boolean;
      }>(
        "filesystem.browse",
        { path },
      ),

    // Thread
    createThread: (workspaceId, title, mode, branch) =>
      rpc<Thread>("thread.create", { workspaceId, title, mode, branch }),
    listThreads: (workspaceId) => rpc<Thread[]>("thread.list", { workspaceId }),
    listRecentThreads: (limit) =>
      rpc<import("./types").RecentThread[]>("thread.recent", limit !== undefined ? { limit } : {}),
    searchThreads: (opts) =>
      rpc<{ threads: Thread[]; workspaces: { id: string; name: string; path: string }[] }>(
        "thread.search",
        {
          query: opts.query,
          filters: opts.filters,
          sort: opts.sort,
          limit: opts.limit,
        },
      ),
    deleteThread: (threadId, cleanupWorktree) =>
      rpc<boolean>("thread.delete", { threadId, cleanupWorktree }),
    completeThread: (threadId) => rpc<Thread>("thread.complete", { threadId }),
    reopenThread: (threadId) => rpc<Thread>("thread.reopen", { threadId }),
    countBlockedThreadCleanupCandidates: () =>
      rpc<{ count: number }>("thread.cleanupBlockedCount", {}),
    retryThreadCleanup: (threadId) =>
      rpc<Thread>("thread.retryCleanup", { threadId }),
    updateThreadTitle: (threadId, title) =>
      rpc<boolean>("thread.updateTitle", { threadId, title }),
    updateThreadSettings: (threadId, settings) =>
      rpc<boolean>("thread.updateSettings", {
        threadId,
        reasoningLevel: settings.reasoningLevel,
        interactionMode: settings.interactionMode,
        orchestrationMode: settings.orchestrationMode,
        permissionMode: settings.permissionMode,
        copilotAgent: settings.copilotAgent,
        contextWindow: settings.contextWindow,
        thinking: settings.thinking,
        codexFastMode: settings.codexFastMode,
        devinMode: settings.devinMode,
        defaultOpenInApp: settings.defaultOpenInApp,
      }),
    markThreadViewed: (threadId) => rpc<void>("thread.markViewed", { threadId }),
    syncThreadPrs: (workspaceId) =>
      rpc<Array<{ threadId: string; prNumber: number; prStatus: string }>>("thread.syncPrs", { workspaceId }),

    // Git
    listBranches: (workspaceId) => rpc<GitBranch[]>("git.listBranches", { workspaceId }),
    getCurrentBranch: (workspaceId) => rpc<string | null>("git.currentBranch", { workspaceId }),
    checkoutBranch: (workspaceId, branch) =>
      rpc<void>("git.checkout", { workspaceId, branch }),
    createBranch: (workspaceId, name, threadId) =>
      rpc<{ branch: string }>("git.createBranch", {
        workspaceId,
        name,
        ...(threadId ? { threadId } : {}),
      }),
    listWorktrees: (workspaceId) => rpc<WorktreeInfo[]>("git.listWorktrees", { workspaceId }),

    // Agent
    sendMessage: (input: SendMessageInput) => {
      const state = useSettingsStore.getState();
      const guardrails = state.loaded
        ? { maxBudgetUsd: state.settings.agent.guardrails.maxBudgetUsd, maxTurns: state.settings.agent.guardrails.maxTurns }
        : {};
      const { replyToMessageId, quotedText, ...command } = input;
      return rpc<void>("agent.send", {
        ...command,
        ...(replyToMessageId && { replyToMessageId }),
        ...(quotedText && { quotedText }),
        ...guardrails,
      });
    },
    getRecoveryIncident: () =>
      rpc<import("@mcode/contracts").RecoveryIncident | null>("agent.recoveryIncident", {}),
    retryTurn: (executionId) => rpc<void>("agent.retry", { executionId }),
    getThreadStartup: (startupId) =>
      rpc<ThreadStartup | null>("thread.startup.get", { startupId }),
    listThreadStartups: (workspaceId) =>
      rpc<ThreadStartupListResult>("thread.startup.list", { workspaceId }),
    cancelThreadStartup: (startupId) =>
      rpc<ThreadStartup>("thread.startup.cancel", { startupId }),
    createAndSendMessage: (input: CreateAndSendInput) => {
      const state = useSettingsStore.getState();
      const guardrails = state.loaded
        ? { maxBudgetUsd: state.settings.agent.guardrails.maxBudgetUsd, maxTurns: state.settings.agent.guardrails.maxTurns }
        : {};
      return rpc<CreateAndSendResult>("agent.createAndSend", {
        ...input,
        ...guardrails,
      });
    },
    stopAgent: (threadId) => rpc<import("@mcode/contracts").AgentStopResult>("agent.stop", { threadId }),
    continueWithoutSaving: (executionId) =>
      rpc<void>("agent.continueWithoutSaving", { executionId }),
    respondToPermission: (requestId, decision, answers, optionId) =>
      rpc<void>("permission.respond", {
        requestId,
        decision,
        ...(answers === undefined ? {} : { answers }),
        ...(optionId === undefined ? {} : { optionId }),
      }),
    listPendingPermissions: (threadId) =>
      rpc<PermissionRequest[]>("permission.listPending", { threadId }),
    answerPlanQuestions: (threadId, answers, permissionMode?, reasoningLevel?, contextWindow?, thinking?) =>
      rpc<void>("agent.answerQuestions", { threadId, answers, permissionMode, reasoningLevel, contextWindow, thinking }),
    dismissPlanQuestions: (threadId) =>
      rpc<void>("agent.dismissPlanQuestions", { threadId }),
    readClipboardImage: () =>
      Promise.resolve(null as AttachmentMeta | null),
    saveClipboardFile: (data, mimeType, fileName) =>
      rpcBinary<AttachmentMeta | null>("clipboard.saveFile", { mimeType, fileName }, data),
    getActiveAgentCount: () => rpc<number>("agent.activeCount", {}),
    listRunning: () => rpc<import("@mcode/contracts").TurnRuntimeSnapshot[]>("agent.listRunning", {}),
    subscribeThread: (threadId) => rpc<void>("push.subscribeThread", { threadId }),
    unsubscribeThread: (threadId) => rpc<void>("push.unsubscribeThread", { threadId }),
    setThreadSubscriptions: (input: SetThreadSubscriptionsInput) =>
      rpc<SetThreadSubscriptionsResult>("push.setThreadSubscriptions", input),
    getThreadGoal: (threadId) =>
      rpc<GoalLookupResult>("thread.goal.get", { threadId }),
    clearThreadGoal: (threadId) =>
      rpc<GoalLookupResult>("thread.goal.clear", { threadId }),
    readThreadControl: (identity, messageLimit) =>
      rpc<import("@mcode/contracts").ThreadControlReadResult>("thread.control.read", {
        identity,
        ...(messageLimit !== undefined ? { messageLimit } : {}),
      }),
    sendThreadControl: (input) =>
      rpc<import("@mcode/contracts").ThreadSendResult>("thread.control.send", input),
    stopThreadControl: (input) =>
      rpc<import("@mcode/contracts").ThreadStopResult>("thread.control.stop", input),

    // Messages
    getMessages: (threadId, limit, before?) =>
      rpc<PaginatedMessages>("message.list", { threadId, limit, ...(before != null ? { before } : {}) }),
    loadConversationPage: (threadId, limit, before?) =>
      rpc<ConversationPage>("conversation.page", { threadId, limit, ...(before != null ? { before } : {}) }),
    loadCanonicalSubagentRoster: (owningParentThreadId, limit?) =>
      rpc<CanonicalSubagentRoster>("canonicalAgent.roster", {
        owningParentThreadId,
        ...(limit !== undefined ? { limit } : {}),
      }),
    stopCanonicalSubagent: (owningParentThreadId, childThreadId) =>
      rpc<CanonicalSubagentStopResult>("agent.child.stop", {
        owningParentThreadId,
        childThreadId,
      }),
    loadOlderConversationPage: (request: ConversationOlderPageRequest) =>
      rpc<ConversationOlderPage>("conversation.olderPage", request),
    loadNewerConversationPage: (request: ConversationNewerPageRequest) =>
      rpc<ConversationNewerPage>("conversation.newerPage", request),
    loadConversationTail: (threadId, limit) =>
      rpc<ConversationTail>("conversation.tail", { threadId, limit }),

    // Config
    discoverConfig: (workspacePath) =>
      rpc<Record<string, unknown>>("config.discover", { workspacePath }),

    // Meta
    getVersion: () => rpc<string>("app.version", {}),

    // Files
    listWorkspaceFiles: (workspaceId, threadId?) =>
      rpc<string[]>("file.list", { workspaceId, threadId }),
    readFileContent: (workspaceId, relativePath, threadId?) =>
      rpc<string>("file.read", { workspaceId, relativePath, threadId }),
    refreshWorkspaceFiles: (workspaceId, threadId?) =>
      rpc<void>("file.refresh", { workspaceId, threadId }),

    // Open-in apps (delegated to desktopBridge; no-op over WS)
    listOpenInApps: async () => (await window.desktopBridge?.listOpenInApps()) ?? [],
    openIn: async (appId, path, line) =>
      window.desktopBridge?.openIn(appId, path, line),

    // GitHub
    getBranchPr: (branch, cwd) =>
      rpc<PrInfo | null>("github.branchPr", { branch, cwd }),
    getPullRequestCapabilities: (request: PullRequestCapabilitiesRequest) =>
      rpc<PullRequestCapabilitiesResult>("pullRequest.capabilities", request),
    listPullRequests: (request: PullRequestListRequest) =>
      rpc<PullRequestListResult>("pullRequest.list", request),
    getPullRequestResource: (request: PullRequestGetRequest) =>
      rpc<PullRequestGetResult>("pullRequest.get", request),
    getPullRequestTimeline: (request: PullRequestTimelineRequest) =>
      rpc<PullRequestTimelineResult>("pullRequest.timeline", request),
    getPullRequestFiles: (request: PullRequestFilesRequest) =>
      rpc<PullRequestFilesResult>("pullRequest.files", request),
    getPullRequestPatch: (request: PullRequestPatchRequest) =>
      rpc<PullRequestPatchResult>("pullRequest.patch", request),
    createPullRequestReviewTask: (request: PullRequestCreateReviewTaskRequest) =>
      rpc<PullRequestCreateReviewTaskResult>("pullRequest.createReviewTask", request),
    getPullRequestReviewLink: (request: PullRequestReviewLinkRequest) =>
      rpc<PullRequestReviewLinkResult>("pullRequest.reviewLink", request),
    postPullRequestComment: (request: PullRequestPostCommentRequest) =>
      rpc<PullRequestPostCommentResult>("pullRequest.postComment", request),
    submitPullRequestReview: (request: PullRequestSubmitReviewRequest) =>
      rpc<PullRequestSubmitReviewResult>("pullRequest.submitReview", request),
    setPullRequestReadiness: (request: PullRequestSetReadinessRequest) =>
      rpc<PullRequestSetReadinessResult>("pullRequest.setReadiness", request),
    closePullRequest: (request: PullRequestCloseRequest) =>
      rpc<PullRequestCloseResult>("pullRequest.close", request),
    mergePullRequest: (request: PullRequestMergeRequest) =>
      rpc<PullRequestMergeResult>("pullRequest.merge", request),
    cancelPullRequestOperation: (request: PullRequestCancelRequest) =>
      rpc<PullRequestCancelResult>("pullRequest.cancel", request),
    listOpenPrs: (workspaceId) => rpc<PrDetail[]>("github.listOpenPrs", { workspaceId }),
    fetchBranch: (workspaceId, branch, prNumber?) =>
      rpc<void>("git.fetchBranch", { workspaceId, branch, prNumber }),
    checkStatus: (threadId, force) =>
      rpc<ChecksStatus>("github.checkStatus", { threadId, force }),

    // Skills
    getProviderCatalog: (request: ProviderCatalogRequest) =>
      rpc<ProviderCatalogSnapshot>("provider.catalog", request),

    // Terminal (PTY)
    terminalProfileList: () => rpc<TerminalProfileList>("terminal.profile.list", {}),
    terminalProfileCreate: (input) =>
      rpc<TerminalCustomProfile>("terminal.profile.create", input),
    terminalProfileUpdate: (input) =>
      rpc<TerminalCustomProfile>("terminal.profile.update", input),
    terminalProfileDelete: (profileId) =>
      rpc<{ deleted: true }>("terminal.profile.delete", { profileId }),
    terminalProfileSetDefault: (profileId) =>
      rpc<{ defaultProfileId: TerminalProfileReference }>(
        "terminal.profile.setDefault",
        { profileId },
      ),
    terminalWorkspacePreferencesGet: (workspaceId) =>
      rpc<TerminalWorkspacePreference>("terminal.workspacePreferences.get", { workspaceId }),
    terminalWorkspacePreferencesUpdate: (workspaceId, profileId) =>
      rpc<TerminalWorkspacePreference>("terminal.workspacePreferences.update", {
        workspaceId,
        defaultProfileId: profileId,
      }),
    terminalWorkspacePreferencesReset: (workspaceId) =>
      rpc<{ reset: true }>("terminal.workspacePreferences.reset", { workspaceId }),
    terminalPreferencesReset: (workspaceId) =>
      rpc<{ reset: true }>("terminal.preferences.reset", workspaceId ? { workspaceId } : {}),
    terminalPreferencesUpdate: (input) =>
      rpc<TerminalPreferencesResult>("terminal.preferences.update", input),
    terminalCapabilities,
    terminalDiagnosticsGetBundle: () =>
      rpc<TerminalDiagnosticsBundle>("terminal.diagnostics.getBundle", {}),
    terminalCreate: (threadId, replacesSessionId) =>
      withTerminalClient((client) => client.create(threadId, replacesSessionId)),
    terminalWrite: (ptyId, data) => withTerminalClient((client) => client.write(ptyId, data)),
    terminalResize: (ptyId, cols, rows) =>
      withTerminalClient((client) => client.resize(ptyId, cols, rows)),
    terminalKill: (ptyId) => withTerminalClient((client) => client.kill(ptyId)),
    terminalPause: (ptyId) => withTerminalClient((client) => client.pause(ptyId)),
    terminalResume: (ptyId) => withTerminalClient((client) => client.resume(ptyId)),
    terminalSubscribe: (ptyId, subscription: TerminalClientSubscription) =>
      terminalClientSelector.getSelected().subscribe(ptyId, subscription),
    terminalDetachForSwitch: (ptyId, checkpoint) =>
      withTerminalClient((client) => client.detachForSwitch(ptyId, checkpoint)),
    terminalNotifyReconnectGap: (ptyId) => {
      terminalClientSelector.getSelected().notifyReconnectGap(ptyId);
    },
    terminalKillByThread: (threadId) =>
      withTerminalClient((client) => client.killByThread(threadId)),
    terminalReattach: (ptyId, lastSeq, cold) =>
      withTerminalClient((client) => client.reattach(ptyId, lastSeq, cold)),
    terminalCheckpoint: (ptyId, seq, data) =>
      withTerminalClient((client) => client.checkpoint(ptyId, seq, data)),
    terminalListActive: () =>
      withTerminalClient((client) => client.listActive()),
    terminalHasChildren: (ptyId) =>
      withTerminalClient((client) => client.hasChildren(ptyId)),
    terminalDiagnostics: () =>
      withTerminalClient((client) => client.diagnostics()),
    ptySetLastSeq: (ptyId, seq) => {
      ptyLastSeqMap.set(ptyId, seq);
      terminalClientSelector.getSelected().acknowledgeOutput?.(ptyId, seq);
    },
    ptyDeleteLastSeq: (ptyId) => { ptyLastSeqMap.delete(ptyId); },

    // Tool call records
    listToolCallRecords: (messageId) =>
      rpc<ToolCallRecord[]>("toolCallRecord.list", { messageId }),
    listToolCallRecordsByParent: (parentToolCallId) =>
      rpc<ToolCallRecord[]>("toolCallRecord.listByParent", { parentToolCallId }),
    listNarrative: (messageId) =>
      rpc<{
        tools: ToolCallRecord[];
        thoughts: ThoughtSegmentRecord[];
        hooks: HookExecutionRecord[];
      }>("narrative.list", { messageId }),
    loadTurn: (threadId, range) =>
      rpc<import("@mcode/contracts").NarrativeEntry[]>("turn.load", {
        threadId,
        ...(range ? { range } : {}),
      }),

    // Thread tasks
    getThreadTasks: (threadId: string) =>
      rpc<Array<{ id?: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; activeForm?: string; group?: string }> | null>(
        "thread.getTasks", { threadId },
      ),

    getThreadPlans: (threadId: string) =>
      rpc<import("@mcode/contracts").PlanRecord[]>("plan.list", { threadId }),

    // Snapshots
    getSnapshotDiff: (snapshotId, filePath?, maxLines?) =>
      rpc<string>("snapshot.getDiff", { snapshotId, filePath, maxLines }),
    getTurnDiffComparison: (threadId, messageId?) =>
      rpc<ReviewComparison | null>("turnDiff.getComparison", {
        threadId,
        includeLive: messageId ? undefined : freshTurnDiffThreads.has(threadId),
        messageId,
      }),
    getTurnDiffFile: (threadId, comparisonId, filePath) => rpc<string>("turnDiff.getFileDiff", { threadId, comparisonId, filePath }),
    getSnapshotDiffStats: (snapshotId) =>
      rpc<DiffStats[]>("snapshot.getDiffStats", { snapshotId }),
    cleanupSnapshots: () =>
      rpc<{ removed: number }>("snapshot.cleanup", {}),
    listSnapshots: (threadId) =>
      rpc<TurnSnapshot[]>("snapshot.listByThread", { threadId }),
    getCumulativeDiff: (threadId, filePath?, maxLines?) =>
      rpc<string>("snapshot.getCumulativeDiff", { threadId, filePath, maxLines }),
    getCumulativeDiffStats: (threadId) =>
      rpc("snapshot.getCumulativeDiffStats", { threadId }),
    getGitLog: (workspaceId, branch?, limit?, baseBranch?, threadId?, options?) =>
      rpc<GitCommit[]>("git.log", {
        workspaceId,
        branch,
        limit,
        baseBranch,
        threadId,
        skip: options?.skip,
        includeStats: options?.includeStats,
      }),
    getCommitDiff: (workspaceId, sha, filePath?, maxLines?) =>
      rpc<string>("git.commitDiff", { workspaceId, sha, filePath, maxLines }),
    getCommitFiles: (workspaceId, sha) =>
      rpc<string[]>("git.commitFiles", { workspaceId, sha }),
    getWorkingTreeFiles: (workspaceId, staged, threadId?) =>
      rpc<string[]>("git.workingTreeFiles", { workspaceId, staged, threadId }),
    getWorkingTreeDiff: (workspaceId, staged, filePath?, maxLines?, threadId?) =>
      rpc<string>("git.workingTreeDiff", { workspaceId, staged, filePath, maxLines, threadId }),
    readFileAtRef: (workspaceId, ref, filePath, threadId?) =>
      rpc<string>("git.fileAtRef", { workspaceId, ref, filePath, threadId }),
    getBranchFiles: (workspaceId, base?, target?, threadId?) =>
      rpc<string[]>("git.branchFiles", { workspaceId, base, target, threadId }),
    getBranchDiff: (workspaceId, base?, target?, filePath?, maxLines?, threadId?) =>
      rpc<string>("git.branchDiff", { workspaceId, base, target, filePath, maxLines, threadId }),
    getBranchComparison: (workspaceId, threadId?) =>
      rpc<BranchComparison>("git.branchComparison", { workspaceId, threadId }),
    getRemoteUrl: (workspaceId, threadId?) =>
      rpc<GitRemoteUrl>("git.getRemoteUrl", { workspaceId, threadId }),
    getReviewDiffStats: (params) =>
      rpc<{ additions: number; deletions: number }>("git.reviewDiffStats", params),
    getReviewComparison: (params) =>
      rpc<import("@mcode/contracts").ReviewComparison>("git.reviewComparison", params),

    // GitHub PR (advanced)
    push: (workspaceId, branch, threadId?) =>
      rpc<{ success: boolean }>("git.push", { workspaceId, branch, threadId }),

    generatePrDraft: (workspaceId, threadId, baseBranch) =>
      rpc<PrDraft>("github.generatePrDraft", {
        workspaceId,
        threadId,
        baseBranch,
      }),

    createPr: (workspaceId, threadId, title, body, baseBranch, isDraft) =>
      rpc<CreatePrResult>("github.createPr", {
        workspaceId,
        threadId,
        title,
        body,
        baseBranch,
        isDraft,
      }),

    // Settings
    getSettings: () => rpc<Settings>("settings.get", {}),
    updateSettings: (partial) => rpc<Settings>("settings.update", partial as Record<string, unknown>),

    // Provider models
    listProviderModels: (providerId) =>
      rpc<ProviderModelInfo[]>("provider.listModels", { providerId }, {
        timeoutMs: PROVIDER_MODEL_LIST_TIMEOUT_MS,
      }),
    listProviderModes: (providerId) =>
      rpc<string[] | null>("provider.listModes", { providerId }),
    getProviderUsage: (providerId) =>
      rpc<ProviderUsageInfo>("provider.getUsage", { providerId }),
    /** Fetches all available Copilot sub-agents for the given workspace (built-in + user + project). */
    listCopilotAgents: (workspaceId) =>
      rpc<CopilotSubagent[]>("provider.copilotAgents", { workspaceId }),
    listProviderAvailability: () =>
      rpc<ProviderAvailability[]>("providers.listAvailability", {}),

    // Diff summaries
    getDiffSummary: (threadId: string) =>
      rpc<{
        id: string;
        threadId: string;
        content: string;
        turnCount: number;
        lastTurnId: string | null;
        model: string;
        createdAt: string;
      } | null>("diffSummary.get", { threadId }),
    generateDiffSummary: (threadId: string) =>
      rpc<{
        id: string;
        threadId: string;
        content: string;
        turnCount: number;
        lastTurnId: string | null;
        model: string;
        createdAt: string;
      }>("diffSummary.generate", { threadId }),
    generateRecap: (threadId, messages, previousRecap) =>
      rpc<{ text: string }>("recap.generate", { threadId, messages, previousRecap }),

    readLatestHandoff: (threadId: string) =>
      rpc<{
        markdown: string;
        meta: {
          schemaVersion: 1;
          parentThreadId: string;
          forkedFromMessageId: string;
          forkAnchorRole: "user" | "assistant";
          childThreadId: string;
          generatedBy: "provider" | "deterministic";
          provider: string | null;
          ladderStep: "B" | "D";
          mode: "full" | "minimal";
          generatedAt: string;
          characterCount: number;
          parentSdkSessionId: string | null;
          providerErrorOnGenerate: "quota" | "auth" | "context-overflow" | "transient" | "fatal" | "clean" | null;
          regenerationHistory: Array<{
            at: string;
            ladderStep: "B" | "D";
            reason: "quota" | "auth" | "context-overflow" | "transient" | "fatal" | "clean" | "user-requested";
          }>;
          attachments: Array<{
            id: string;
            originalName: string;
            sha256: string;
            mime: string;
            parentMessageId: string;
          }>;
        };
      } | null>("handoff.readLatest", { threadId }),

    // Memory pressure
    setBackground: (background) => rpc<void>("memory.setBackground", { background }),

    // Lifecycle
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      rejectReady(new Error("Transport closed"));
      rejectPending("Transport closed");
      ws.close();
    },
  };
}
