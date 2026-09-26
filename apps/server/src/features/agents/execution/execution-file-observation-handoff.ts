import type { AgentEvent, ProviderFileMutationStart } from "@mcode/contracts";

import type {
  CapturedToolUseObservation,
  FileTurnHandoff,
  TurnFileTracker,
} from "../turns/turn-file-tracker.js";

const MAX_PENDING = 8;
const MAX_PENDING_BYTES = 4 * 1_048_576;
const MAX_CAPTURE_BYTES = 1_310_720;
const MAX_SEEN = 1_024;

type PendingObservation = { readonly captured: CapturedToolUseObservation; readonly bytes: number };
type ToolUse = Extract<AgentEvent, { type: "toolUse" }>;

/** Keeps synchronous pre-edit evidence for one exact execution until its tool event is admitted. */
export class ExecutionFileObservationHandoff {
  private readonly pending = new Map<string, PendingObservation>();
  private readonly seen = new Set<string>();
  private pendingBytes = 0;
  private closed = false;

  constructor(
    private readonly tracker: TurnFileTracker,
    private readonly handoff: FileTurnHandoff,
    private readonly deliveryAttempt: number,
  ) {
    if (!Number.isSafeInteger(deliveryAttempt) || deliveryAttempt < 1) {
      throw new Error("A positive file observation delivery attempt is required");
    }
  }

  /** Capture before returning to the provider notification loop; no asynchronous read precedes this call. */
  capture(event: ProviderFileMutationStart): boolean {
    if (!this.matches(event)) return false;
    const key = event.toolCallId;
    if (this.seen.has(key)) {
      this.forget(key);
      return false;
    }
    if (this.seen.size >= MAX_SEEN) return false;
    this.seen.add(key);
    if (this.pending.size >= MAX_PENDING) return false;
    const captured = this.tracker.captureToolUseObservation(
      event.threadId, key, event.toolName, event.toolInput,
    );
    if (!captured || !this.matchesCapture(captured)) return false;
    const bytes = Buffer.byteLength(JSON.stringify(captured), "utf8");
    if (bytes > MAX_CAPTURE_BYTES || this.pendingBytes + bytes > MAX_PENDING_BYTES) return false;
    this.pending.set(key, { captured, bytes });
    this.pendingBytes += bytes;
    return true;
  }

  /** The caller must supply the tool event's source attempt, not its current scheduler attempt. */
  take(event: ToolUse, deliveryAttempt: number): CapturedToolUseObservation | null {
    if (!this.matches({ ...event, deliveryAttempt })) return null;
    const pending = this.pending.get(event.toolCallId);
    if (!pending) return null;
    this.forget(event.toolCallId);
    return pending.captured;
  }

  /** Fence Stop, retry, worker loss, or terminal handling before any later provider callback. */
  close(): void {
    this.closed = true;
    this.pending.clear();
    this.seen.clear();
    this.pendingBytes = 0;
  }

  private matches(event: { readonly threadId: string; readonly turnExecutionId?: string;
    readonly deliveryAttempt?: number }): boolean {
    return !this.closed && event.threadId === this.handoff.threadId
      && event.turnExecutionId === this.handoff.executionId
      && event.deliveryAttempt === this.deliveryAttempt
      && this.tracker.getCurrentTurnId(this.handoff.threadId) === String(this.handoff.generation);
  }

  private matchesCapture(captured: CapturedToolUseObservation): boolean {
    return captured.executionId === this.handoff.executionId
      && captured.generation === this.handoff.generation
      && captured.generationToken === this.handoff.generationToken
      && captured.canonicalRoot === this.handoff.canonicalRoot;
  }

  private forget(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    this.pendingBytes -= pending.bytes;
  }
}
