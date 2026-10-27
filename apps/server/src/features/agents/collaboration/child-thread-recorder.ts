import type { AgentItem, AgentTurn } from "@mcode/contracts/compat/agent-model";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import type { CodexChildRoutingDiagnosticInput, CodexCollaborationDurability } from "./codex-collaboration-durability.js";

/** Recorder-owned brand for resolved delegations. */
export const childThreadHandle: unique symbol = Symbol("ChildThreadHandle");

/** Resolved child of one delegation, constructed by the recorder. */
export interface ChildThreadHandle {
  readonly [childThreadHandle]: true;
  readonly parentThreadId: string;
  readonly parentItemId: string;
  readonly childThreadId: string;
  readonly turnId: string;
}

/** The running owner and native metadata of a delegation. */
export interface ChildDelegationInput {
  readonly providerId: ProviderId;
  readonly parentThreadId: string;
  readonly parentTurnId: string;
  readonly parentItemId: string;
  readonly nativeParentItemId: string;
  readonly prompt: string;
  readonly title?: string;
  readonly agentType?: string;
}

/** Content observed in a resolved child turn. */
export type ChildItemInput =
  | { readonly kind: "message"; readonly nativeItemId: string; readonly text: string; readonly mode: "append" | "replace" }
  | { readonly kind: "tool-call"; readonly nativeItemId: string; readonly toolName: string; readonly toolInput: Record<string, unknown> }
  | { readonly kind: "tool-result"; readonly nativeItemId: string; readonly output: string; readonly isError: boolean };

/** First terminal outcome observed for a child. */
export type ChildTurnClose =
  | { readonly outcome: "completed" | "interrupted" | "cancelled" }
  | { readonly outcome: "errored"; readonly error: string };

/** Owner reads needed to resolve a root or nested delegation. */
export type ChildThreadReads = Pick<CodexCollaborationDurability, "loadTurn" | "loadTurnByExecution">;

/** Child writes over accepted state. Final messages replace deltas and ignore later appends; the first terminal outcome wins. */
export interface ChildThreadRecorder {
  delegate(input: ChildDelegationInput): ChildThreadHandle;
  findDelegation(parentThreadId: string, parentItemId: string): ChildThreadHandle | null;
  recordChildItem(child: ChildThreadHandle, item: ChildItemInput): AgentItem;
  closeChild(child: ChildThreadHandle, close: ChildTurnClose): AgentTurn;
  reject(diagnostic: CodexChildRoutingDiagnosticInput): void;
}

/** A data refusal that must become a parent diagnostic instead of failing its turn. */
export class ChildThreadRejection extends Error {
  constructor(readonly reason: "unknown-delegation" | "child-turn-terminal" | "duplicate-mismatch"
    | "parent-turn-not-running" | "child-transcript-not-declared" | "missing-native-item-id" | "unsupported-event-type") {
    super(reason);
  }
}
