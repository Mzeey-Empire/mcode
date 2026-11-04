import type { DiagIds } from "./record.js";

declare const payload: unique symbol;

/** Catalog declaration for a point observation. */
export interface EventChannel<P, I extends keyof DiagIds> {
  kind: "event";
  ids: readonly I[];
  [payload]?: P;
}

/** Catalog declaration for a timed action; null budgets represent human waits. */
export interface SpanChannel<B, E, I extends keyof DiagIds> {
  kind: "span";
  ids: readonly I[];
  expectMs: number | null;
  [payload]?: [B, E];
}

/** Declare the payload and required correlation ids of an event. */
export function event<P>() {
  return <I extends keyof DiagIds>(ids: readonly I[]): EventChannel<P, I> => {
    return { kind: "event", ids };
  };
}

/** Declare begin/end payloads and the action's time budget. */
export function span<B, E = undefined>() {
  return <I extends keyof DiagIds>(
    ids: readonly I[],
    expectMs: number | null,
  ): SpanChannel<B, E, I> => {
    return { kind: "span", ids, expectMs };
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

/** One declaration per channel; readers use the budgets stamped into records. */
export const DIAG_CATALOG = {
  // `children: "job"` means provider processes die with this process, so an abrupt exit also ends them.
  "app.run": event<{ pid: number; previous: "clean" | "unclean" | "first"; previousPid?: number; children: "job" | "none" }>()([]),
  // Retains every shutdown requester, including requests that lost the race.
  "app.shutdown": event<{ trigger: "http" | "signal" | "idle"; signal?: string; client?: string; accepted: boolean }>()([]),
  // Shows how far a shutdown got when the process is killed before it can record its exit.
  "app.phase": event<{ phase: string }>()([]),
  // Makes a recorded exit distinguishable from a run that simply stopped recording.
  // `control` names the app.control record whose command ended the process.
  // Errors retain the failed cleanup cause even when later shutdown phases completed.
  "app.exit": event<{ code: number; phase: string; uptimeMs: number; fatal?: "uncaughtException" | "unhandledRejection"; control?: string; errors?: { name: string; message: string }[] }>()([]),
  // Bounds a late callback without claiming an exact stall onset.
  "app.stall": event<{ lastOnTimeAt: number; lateCallbackAt: number; intervalMs: number; lateMs: number }>()([]),
  // Preserves intentional harness faults before they affect the server; `id` links the effects they cause.
  "app.control": event<{ id: string; control: string; durationMs?: number; client: string }>()([]),
  "app.hang": event<{ control: string; startedAt: number; endedAt: number; elapsedMs: number }>()([]),
  "rpc.request": event<RpcRequestPayload>()([]),
  "codex.wire": event<CodexWirePayload>()(["th"]),
  "claude.stream": event<ClaudeStreamPayload>()(["th"]),
  "claude.turn": event<ClaudeTurnPayload>()(["th"]),
  // Links the owned CLI's lifetime and retirement outcome to its thread.
  "claude.process": event<
    | { step: "spawned"; pid: number }
    | { step: "exited"; pid: number; code: number | null; signal: string | null }
    | { step: "terminating"; pid: number }
    | { step: "terminated"; pid: number; ok: boolean }
  >()(["th"]),
  // Identifies late batches rejected after their execution lost admission.
  "provider.refused": event<{ turn: string; execution: string; phase: string; events: number; types: string[] }>()(["th"]),
  // Names accepted events a save left on disk unwritten; `exhausted` means no retry follows.
  "progress.save-failed": event<{ turn: string; execution: string; source: "storage" | "receipt"; error: string; exhausted: boolean; events: number; types: string[] }>()(["th"]),
  "cursor.wire": event<CursorWirePayload>()(["th"]),
  "cursor.session": event<{ operation: string }>()(["th"]),
  "approval": span<{ provider: string | null }, { status: string } | undefined>()(["th"], null),
  // Separates server publication delay from time spent waiting on clients or people.
  "approval.push": event<{ request: string; kind: "requested" | "resolved"; conns: string[] }>()(["th"]),
  // Links restart interruptions to their durable recovery provenance.
  "turn.recovered": event<{ turn: string; execution: string; incident: string; cause: "app_closed"; reason: string }>()(["th"]),
  // Shows whether provider shutdown left an execution for startup recovery.
  "agent.stopped": event<{ execution: string; turn: string; phase: string; terminal: boolean }>()(["th"]),
  "agent.send": span<ActionPayload>()(["th"], 30_000),
  "agent.created": event<ActionPayload>()(["th"]),
  "agent.stop": span<ActionPayload>()(["th"], 10_000),
  "push.canonical": event<CanonicalPushPayload>()(["th"]),
  "mcp.tool": span<McpToolPayload, { isError: boolean }>()(["th"], 60_000),
  // thread_wait holds the call open until another thread needs attention, so it has no budget.
  "mcp.wait": span<McpToolPayload, { isError: boolean }>()(["th"], null),
  "delegate.task": event<DelegateStep>()(["th"]),
  "delegate.wake": event<DelegateWake>()(["th"]),
  "delegate.launch": span<{ taskId: string }, { child: string }>()(["th"], 60_000),
  // Starts when results are steered into a running Coordinator turn; delegate.wake records whether they reached it.
  "delegate.steer": span<{ wake: string }>()(["th"], 30_000),
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
