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

type CodexWirePayload = {
  method: string;
  raw: Record<string, unknown>;
  mapped: readonly Record<string, unknown>[];
};

type ClaudeStreamPayload = {
  type: string;
  subtype?: string;
  eventType?: string;
};

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

/** One declaration per channel; readers use the budgets stamped into records. */
export const DIAG_CATALOG = {
  "codex.wire": event<CodexWirePayload>()(["th"]),
  "claude.stream": event<ClaudeStreamPayload>()(["th"]),
  "cursor.wire": event<CursorWirePayload>()(["th"]),
  "cursor.session": event<{ operation: string }>()(["th"]),
  "approval": span<{ provider: string | null }, { status: string } | undefined>()(["th"], null),
  "agent.send": span<ActionPayload>()(["th"], 30_000),
  "agent.created": event<ActionPayload>()(["th"]),
  "agent.stop": span<ActionPayload>()(["th"], 10_000),
  "push.canonical": event<CanonicalPushPayload>()(["th"]),
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
