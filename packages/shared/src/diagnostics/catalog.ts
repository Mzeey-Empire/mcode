import type { DiagIds } from "./record.js";

declare const payload: unique symbol;

/** Catalog declaration for a point observation. */
export interface EventChannel<P, I extends keyof DiagIds> {
  kind: "event";
  ids: readonly I[];
  /** What one record means; the only description of the channel that agents reading a recording get. */
  about: string;
  [payload]?: P;
}

/** Catalog declaration for a timed action; null budgets represent human waits. */
export interface SpanChannel<B, E, I extends keyof DiagIds> {
  kind: "span";
  ids: readonly I[];
  expectMs: number | null;
  /** What the span covers from begin to end; the only description of the channel that agents reading a recording get. */
  about: string;
  [payload]?: [B, E];
}

/** Declare the payload, required correlation ids, and meaning of an event. */
export function event<P>() {
  return <I extends keyof DiagIds>(ids: readonly I[], about: string): EventChannel<P, I> => {
    return { kind: "event", ids, about };
  };
}

/** Declare begin/end payloads, the action's time budget, and what the span covers. */
export function span<B, E = undefined>() {
  return <I extends keyof DiagIds>(
    ids: readonly I[],
    expectMs: number | null,
    about: string,
  ): SpanChannel<B, E, I> => {
    return { kind: "span", ids, expectMs, about };
  };
}

type ActionPayload = {
  provider?: string;
  mode?: string;
  by?: string;
  reason?: string;
};

type RpcRequestPayload = {
  method: string;
  req: string;
  conn: string;
  client: string;
  receivedAt: number;
  ms: number;
  outcome: "ok" | "error";
  error?: string;
  approval?: string;
};

type CodexWirePayload = {
  method: string;
  raw: Record<string, unknown>;
  mapped: readonly Record<string, unknown>[];
};

type ClaudeStreamPayload = {
  type: string;
  subtype?: string;
  eventType?: string;
  uuid?: string;
  taskId?: string;
  toolUseId?: string;
  status?: string;
  state?: string;
  phase?: string;
  terminalReason?: string;
  stopReason?: string;
  isError?: boolean;
  aborted?: boolean;
  /** The sub-agent tool call this message belongs to; absent for the main agent. */
  parent?: string;
  tools?: readonly { name: string; id: string }[];
  results?: readonly { id: string; isError: boolean }[];
};

type ClaudeTurnPayload =
  // Links the queued prompt to SDK frames carrying its UUID. Steers queue at priority "now", which cuts open tools short.
  | {
      step: "steer-queued";
      steer: string;
      // Names tools a steer can cut short without inferring from timestamps.
      openTools: string[];
    }
  // Distinguishes a confirmed answer from a refused or uncertain delivery.
  | { step: "steer-outcome"; steer: string; outcome: string }
  // Explains why an SDK result did not end the Mcode turn, naming the steers it was cut short for.
  | { step: "segment-absorbed"; terminalReason?: string; steers: string[] }
  // Preserves the user's stop even when no session exists yet.
  | {
      step: "stop-requested";
      hadSession: boolean;
      // Preserves tools open before session teardown clears them.
      openTools: string[];
    }
  // Separates discarded streams from other endings; a stop shows as `stop-requested` before `ended`.
  | { step: "stream-ended"; cause: "discarded" | "ended" };

type CursorWirePayload = {
  raw: unknown;
  mapped?: readonly Record<string, unknown>[];
};

type CanonicalPushPayload = {
  phase: string;
  from?: number;
  through?: number;
  acceptedThrough?: number;
  savedThrough?: number;
  events: number;
  children: number;
};

type McpToolPayload = {
  tool: string;
  callId: string;
};

type DelegateStep =
  | { step: "claimed"; taskId: string; provider: string; model: string; checkout: string }
  | { step: "awaiting-approval"; taskId: string }
  | { step: "cancelled"; taskId: string; by: string };

/** Why a Coordinator did or did not receive its delegated tasks' results on one pass. */
type DelegateWake =
  | { outcome: "held"; reason: "turn-without-lease" | "steer-refused" | "busy" | "user-stopped" }
  | { outcome: "sent" | "steered"; wake: string; reached: boolean };

/**
 * One declaration per channel, and the single description of what each channel records.
 * Readers use the budgets stamped into records.
 */
export const DIAG_CATALOG = {
  "app.run": event<{ pid: number; previous: "clean" | "unclean" | "first"; previousPid?: number; children: "job" | "none" }>()(
    [],
    "One per server start: its pid, whether the previous run exited cleanly, and whether provider processes die with this one. `children: \"job\"` means an abrupt exit also ends them.",
  ),
  "app.shutdown": event<{ trigger: "http" | "signal" | "idle"; signal?: string; client?: string; accepted: boolean }>()(
    [],
    "Every shutdown request and who sent it. `accepted` is true only for the first; later requests that lost the race are kept with `accepted: false`.",
  ),
  "app.phase": event<{ phase: string }>()(
    [],
    "Each shutdown phase as it starts, so a run killed before it recorded app.exit still shows how far shutdown got.",
  ),
  "app.exit": event<{ code: number; phase: string; uptimeMs: number; fatal?: "uncaughtException" | "unhandledRejection"; control?: string; errors?: { name: string; message: string }[] }>()(
    [],
    "The process's own exit: code, last phase, and uptime. `control` names the app.control whose command ended it; `errors` keeps up to three failed cleanup causes even when later phases completed. A run with no app.exit was killed, crashed, or still running at capture; the absence does not name a killer.",
  ),
  "app.stall": event<{ lastOnTimeAt: number; lateCallbackAt: number; intervalMs: number; lateMs: number }>()(
    [],
    "A timer callback that ran late. It bounds a stall between `lastOnTimeAt` and `lateCallbackAt`; it does not give an exact onset.",
  ),
  "app.control": event<{ id: string; control: string; durationMs?: number; client: string }>()(
    [],
    "An accepted reliability-harness command, recorded before it takes effect, with the kind of client that sent it. Its `id` reappears on the app.hang it caused and on the app.exit of a run it ended.",
  ),
  "app.hang": event<{ control: string; startedAt: number; endedAt: number; elapsedMs: number }>()(
    [],
    "A hang the reliability harness caused and measured; `control` is the app.control id.",
  ),
  "rpc.request": event<RpcRequestPayload>()(
    [],
    "When the server received a send, stop, steer, retry, resume, question answer, or approval answer, over which socket (`conn`), from which kind of client, and its outcome. An approval answer has no thread; `approval` links it to its thread's approval span.",
  ),
  "ws.connection": event<{ step: "opened"; conn: string; client: string } | { step: "closed"; conn: string; code: number }>()(
    [],
    "When each socket opened and from which kind of client, and when it closed with which close code. `conn` matches rpc.request and approval.push, so a request or push can be tied to its socket's lifetime.",
  ),
  "codex.wire": event<CodexWirePayload>()(
    ["th"],
    "Each Codex app-server message for the thread and the canonical events the adapter mapped from it.",
  ),
  "claude.stream": event<ClaudeStreamPayload>()(
    ["th"],
    "Each Claude SDK message: uuid, task and tool ids, the tool calls it starts or finishes, and terminal reasons. Follow a steer's id from claude.turn `steer-queued` through the messages that name it.",
  ),
  "claude.turn": event<ClaudeTurnPayload>()(
    ["th"],
    "The Claude adapter's own decisions: steer queued and answered, a cut-short segment absorbed while steers waited, stop requested, and stream ended with the cause the adapter knew.",
  ),
  "claude.process": event<
    | { step: "spawned"; pid: number }
    | { step: "exited"; pid: number; code: number | null; signal: string | null }
    | { step: "terminating"; pid: number }
    | { step: "terminated"; pid: number; ok: boolean }
  >()(
    ["th"],
    "The thread's Claude CLI process: spawn, exit code or signal, and process-tree termination.",
  ),
  "provider.refused": event<{ turn: string; execution: string; phase: string; events: number; types: string[] }>()(
    ["th"],
    "Provider events the server refused because their execution had already ended.",
  ),
  "progress.save-failed": event<{ turn: string; execution: string; source: "storage" | "receipt"; error: string; exhausted: boolean; events: number; types: string[] }>()(
    ["th"],
    "Accepted events a save could not write. `exhausted` means the failure is reported to waiters; retries continue in the background until a save succeeds.",
  ),
  "progress.content-replaced": event<{ turn: string; execution: string; operation: string; reason: string }>()(
    ["th"],
    "An accepted operation whose contents the writer rejected. Its events were saved without the publication, narrative, features, or messages it carried.",
  ),
  "cursor.wire": event<CursorWirePayload>()(
    ["th"],
    "Each Cursor ACP message for the thread and the canonical events the adapter mapped from it.",
  ),
  "cursor.session": event<{ operation: string }>()(
    ["th"],
    "A Cursor session operation, such as reusing a live session.",
  ),
  "approval": span<{ provider: string | null }, { status: string } | undefined>()(
    ["th"],
    null,
    "An approval request from the provider until it is answered. It waits on a person, so it has no budget.",
  ),
  "approval.push": event<{ request: string; kind: "requested" | "resolved"; conns: string[] }>()(
    ["th"],
    "When an approval request or resolution was written to sockets, and which `conn`s. It does not confirm a client received it; it separates server delay from time spent waiting on clients or people.",
  ),
  "session.evict": event<{ reason: "idle" | "memory-pressure"; idleMs: number; turnBusy: boolean; nativeTasks: number; nativeProtecting: number; held: boolean }>()(
    ["th"], "A pooled session became evictable under its occupancy policy.",
  ),
  "session.shutdown-held": event<{ held: boolean; nativeTasks: number; nativeProtecting: number }>()(
    ["th"], "Shutdown stopped a session with protected background work.",
  ),
  "turn.recovered": event<{ turn: string; execution: string; incident: string; cause: "app_closed"; reason: string }>()(
    ["th"],
    "An execution that a server start found interrupted by the previous run, and the recovery incident it created.",
  ),
  "agent.stopped": event<{ execution: string; turn: string; phase: string; terminal: boolean }>()(
    ["th"],
    "A shutdown stop finished for the thread: the runtime phase, and whether a terminal outcome was committed. `terminal: false` leaves the execution for startup recovery.",
  ),
  "agent.send": span<ActionPayload>()(
    ["th"],
    30_000,
    "Sending one admitted turn through its provider, from the server's call to the provider's acceptance.",
  ),
  "agent.created": event<ActionPayload>()(
    ["th"],
    "A thread created together with its first turn.",
  ),
  "agent.stop": span<ActionPayload>()(
    ["th"],
    10_000,
    "Stopping the thread's active turn. `by` names who stopped it; `by: \"shutdown\"` marks a thread the server stopped while shutting down.",
  ),
  "push.canonical": event<CanonicalPushPayload>()(
    ["th"],
    "Canonical events pushed to clients, by phase (accepted, saved, or recovery), with the sequence range and event count.",
  ),
  "mcp.tool": span<McpToolPayload, { isError: boolean }>()(
    ["th"],
    60_000,
    "One Mcode MCP tool call made by the thread's agent.",
  ),
  "mcp.wait": span<McpToolPayload, { isError: boolean }>()(
    ["th"],
    null,
    "A thread_wait call. It stays open until another thread needs attention, so it has no budget.",
  ),
  "delegate.task": event<DelegateStep>()(
    ["th"],
    "A delegated task's steps on the Coordinator: claimed (with provider, model, and checkout), awaiting approval, or cancelled.",
  ),
  "delegate.wake": event<DelegateWake>()(
    ["th"],
    "Whether the Coordinator received its delegated tasks' results on one pass, or why they were held. `reached` is stamped when the result's message is saved, which can trail the moment the provider received it.",
  ),
  "delegate.launch": span<{ taskId: string }, { child: string }>()(
    ["th"],
    60_000,
    "Launching a delegated child thread; the end names the child.",
  ),
  "delegate.steer": span<{ wake: string }>()(
    ["th"],
    30_000,
    "Results steered into a running Coordinator turn; delegate.wake records whether they reached it.",
  ),
};

type Catalog = typeof DIAG_CATALOG;

/** Catalog-derived channel names. */
export type DiagChannelName = keyof Catalog;

/** Point channel names. */
export type EventName = {
  [C in DiagChannelName]: Catalog[C]["kind"] extends "event" ? C : never;
}[DiagChannelName];

/** Timed channel names. */
export type SpanName = Exclude<DiagChannelName, EventName>;

/** Required ids are derived from the catalog. */
export type IdsOf<C extends DiagChannelName> = DiagIds &
  Required<Pick<DiagIds, Catalog[C]["ids"][number]>>;

/** Payload derived from a point channel declaration. */
export type EventPayload<C extends EventName> = NonNullable<Catalog[C][typeof payload]>;

/** Payload derived from a span's begin declaration. */
export type BeginPayload<C extends SpanName> = NonNullable<Catalog[C][typeof payload]>[0];

/** Recorder-owned errors are valid for every span. */
export type EndPayload<C extends SpanName> =
  | NonNullable<Catalog[C][typeof payload]>[1]
  | { error: string };
