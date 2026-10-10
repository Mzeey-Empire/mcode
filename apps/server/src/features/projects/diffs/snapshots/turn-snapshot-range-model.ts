// Kept free of DI and database imports so WebSocket transports can load it without a reflect polyfill.
import type { TurnSnapshot } from "@mcode/contracts";
import { collectAttributedWorkspacePathGroups } from "./snapshot-attribution.js";

/** A whole logical turn, including attempts whose snapshot was never written. */
export interface SnapshotTurn {
  messageId: string;
  messageIds: string[];
  ordinal: number;
  createdAt: string;
  phase: "live" | "settled";
  complete: boolean;
  rows: TurnSnapshot[];
}

/** Complete attributed evidence, or an expired logical turn. */
export type TurnSnapshotRange = {
  status: "ready";
  rows: [TurnSnapshot, ...TurnSnapshot[]];
  refBefore: string;
  refAfter: string;
  paths: string[];
  pathGroups: string[][];
} | { status: "unavailable"; reason: "snapshot-expired" };

/** Build range refs and attribution without collapsing rename groups from different rows. */
export function snapshotRange(rows: readonly TurnSnapshot[]): TurnSnapshotRange {
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last) return { status: "unavailable", reason: "snapshot-expired" };
  const pathGroups = collectAttributedWorkspacePathGroups(rows);
  return { status: "ready", rows: [first, ...rows.slice(1)], refBefore: first.ref_before, refAfter: last.ref_after,
    pathGroups, paths: [...new Set(pathGroups.flat())] };
}
