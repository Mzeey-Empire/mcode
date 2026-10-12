import type { ToolCall } from "@/transport/types";
import { statusPhrase } from "../turn-ending/provider-retry";
import { toolActivityLabel } from "./activity-label";

/** Single source for the status line label and icon. `dot` marks a turn held on the user, with no step count or clock. */
export type RunStatus = { label: string; icon: "layers" | "spinner" | "dot" };

/** A provider retry holding the turn; `errorStatus` is the HTTP status that triggered it, absent for connection errors. */
export type RunRetry = { kind: "rate-limited" } | { kind: "retrying"; errorStatus?: number };

/** Turn-level holding states read from the thread record and store, not from narrative events. */
export interface RunHoldingSignals {
  stopPending: boolean;
  compacting: boolean;
  retry?: RunRetry;
  waitingFor?: "approval" | "answers";
}

/** Everything the status line needs to pick one label for a running turn. */
export interface RunStatusInput extends RunHoldingSignals {
  /** Latest incomplete top-level call that is not an Agent call. */
  activeTool?: ToolCall;
  /** Any incomplete top-level Agent call. */
  subagentsRunning: boolean;
  /** The provisional answer slot is non-empty. */
  answering: boolean;
  /** Complete heading from the open narration segment, shown only in place of "Thinking". */
  summaryHeading?: string;
}

interface RunStatusRule {
  icon: RunStatus["icon"];
  label: (input: RunStatusInput) => string | undefined;
}

function retryLabel(retry: RunRetry): string {
  if (retry.kind === "rate-limited") return "Rate limited";
  return retry.errorStatus === undefined ? "Retrying" : `Retrying after ${statusPhrase(retry.errorStatus)}`;
}

const WAITING_LABELS = { approval: "Waiting for approval", answers: "Waiting for your answers" } as const;

/** Precedence order is the product decision; the first rule with a label wins, else the default row. */
const RUN_STATUS_RULES: readonly RunStatusRule[] = [
  { icon: "spinner", label: (input) => (input.stopPending ? "Stopping" : undefined) },
  { icon: "spinner", label: (input) => (input.compacting ? "Compacting context" : undefined) },
  { icon: "spinner", label: (input) => (input.retry ? retryLabel(input.retry) : undefined) },
  { icon: "dot", label: (input) => (input.waitingFor ? WAITING_LABELS[input.waitingFor] : undefined) },
  { icon: "layers", label: (input) => (input.activeTool ? toolActivityLabel(input.activeTool) : undefined) },
  { icon: "layers", label: (input) => (input.subagentsRunning ? "Waiting on subagents" : undefined) },
  { icon: "layers", label: (input) => (input.answering ? "Answering" : undefined) },
];

/** Picks the status line label and icon for a running turn. */
export function deriveRunStatus(input: RunStatusInput): RunStatus {
  for (const rule of RUN_STATUS_RULES) {
    const label = rule.label(input);
    if (label !== undefined) return { label, icon: rule.icon };
  }
  return { label: input.summaryHeading ?? "Thinking", icon: "layers" };
}
