import { describe, expect, it } from "vitest";
import { transitionCompletion, type CompletionEntry } from "../completion-machine";

const holding: CompletionEntry = { phase: "holding", attempt: 1 };
const lingering: CompletionEntry = { phase: "lingering" };
const failed: CompletionEntry = { phase: "failed", failure: { kind: "retryable", message: "socket closed" } };

describe("transitionCompletion", () => {
  it("starts holding and sends the request at click", () => {
    expect(transitionCompletion(undefined, { type: "complete", attempt: 1 })).toEqual({
      next: holding,
      effects: [{ type: "send-complete", attempt: 1 }],
    });
  });

  it("returns the row and reopens on Undo during the hold", () => {
    expect(transitionCompletion(holding, { type: "undo" })).toEqual({ next: undefined, effects: [{ type: "send-reopen" }] });
  });

  it("applies the confirmation and settles, or lingers under the pointer", () => {
    expect(transitionCompletion(holding, { type: "confirmed", attempt: 1, pointerOnRow: false })).toEqual({
      next: undefined,
      effects: [{ type: "apply-confirmed" }],
    });
    expect(transitionCompletion(holding, { type: "confirmed", attempt: 1, pointerOnRow: true })).toEqual({
      next: lingering,
      effects: [{ type: "apply-confirmed" }],
    });
  });

  it("treats a duplicate confirmation as a no-op", () => {
    expect(transitionCompletion(undefined, { type: "confirmed", attempt: 1, pointerOnRow: false })).toEqual({ next: undefined, effects: [] });
    expect(transitionCompletion(lingering, { type: "confirmed", attempt: 1, pointerOnRow: false })).toEqual({ next: lingering, effects: [] });
  });

  it("returns the row silently when the hold was cancelled after Undo", () => {
    const afterUndo = transitionCompletion(holding, { type: "undo" }).next;

    expect(transitionCompletion(afterUndo, { type: "refused", attempt: 1, refusal: "cancelled" })).toEqual({ next: undefined, effects: [] });
    expect(transitionCompletion(holding, { type: "refused", attempt: 1, refusal: "cancelled" })).toEqual({ next: undefined, effects: [] });
  });

  it("ignores a reply from an earlier attempt", () => {
    const retried: CompletionEntry = { phase: "holding", attempt: 2 };

    expect(transitionCompletion(retried, { type: "refused", attempt: 1, refusal: "busy" })).toEqual({ next: retried, effects: [] });
  });

  it("fails with the refusal reason, or as retryable on a connection error", () => {
    expect(transitionCompletion(holding, { type: "refused", attempt: 1, refusal: "running" }).next).toEqual({
      phase: "failed",
      failure: { kind: "refused", refusal: "running", message: "The thread is running" },
    });
    expect(transitionCompletion(holding, { type: "connection-failed", attempt: 1, message: "socket closed" }).next).toEqual(failed);
  });

  it("leaves lingering when the pointer leaves, on Undo, or when the server reopens", () => {
    expect(transitionCompletion(lingering, { type: "pointer-left" })).toEqual({ next: undefined, effects: [] });
    expect(transitionCompletion(lingering, { type: "undo" })).toEqual({ next: undefined, effects: [{ type: "send-reopen" }] });
    expect(transitionCompletion(lingering, { type: "server-lifecycle", completed: false })).toEqual({ next: undefined, effects: [] });
  });

  it("retries from failed, dismisses on Undo, and clears when the server completes", () => {
    expect(transitionCompletion(failed, { type: "retry", attempt: 2 })).toEqual({
      next: { phase: "holding", attempt: 2 },
      effects: [{ type: "send-complete", attempt: 2 }],
    });
    expect(transitionCompletion(failed, { type: "undo" })).toEqual({ next: undefined, effects: [] });
    expect(transitionCompletion(failed, { type: "server-lifecycle", completed: true })).toEqual({ next: undefined, effects: [] });
  });

  it("ignores a second click while holding", () => {
    expect(transitionCompletion(holding, { type: "complete", attempt: 2 })).toEqual({ next: holding, effects: [] });
  });
});
