import { describe, expect, it } from "vitest";
import {
  getComposerSendButtonVisualState,
  isComposerSendButtonDisabled,
  SEND_BUTTON_VARIANT,
} from "./ComposerContentSurface";

const disabledArgs = {
  needsWorkspace: false,
  providerReason: null,
  isStaleWorktree: false,
  planPending: false,
  startingThread: false,
  isAgentRunning: true,
  isStopPending: false,
  hasContent: false,
  canCancelStartup: false,
  targetPending: false,
} as const;

describe("composer send button stopping state", () => {
  it("shows a distinct stopping state while the stop request is in flight", () => {
    expect(getComposerSendButtonVisualState({
      startingThread: false,
      isAgentRunning: true,
      isStopPending: true,
      hasContent: false,
    })).toBe("stopping");
  });

  it("stays in stopping state even when the composer has queued content", () => {
    expect(getComposerSendButtonVisualState({
      startingThread: false,
      isAgentRunning: true,
      isStopPending: true,
      hasContent: true,
    })).toBe("stopping");
  });

  it("disables the button while the stop request is in flight", () => {
    expect(isComposerSendButtonDisabled({ ...disabledArgs, isStopPending: true })).toBe(true);
  });

  it("returns to the stop state once the request settles", () => {
    expect(getComposerSendButtonVisualState({
      startingThread: false,
      isAgentRunning: true,
      isStopPending: false,
      hasContent: false,
    })).toBe("stop");
    expect(isComposerSendButtonDisabled({ ...disabledArgs, isStopPending: false })).toBe(false);
  });
});

describe("composer send button with a pending target branch", () => {
  it("disables Send while a new thread has content but no branch yet", () => {
    expect(isComposerSendButtonDisabled({
      ...disabledArgs,
      isAgentRunning: false,
      hasContent: true,
      targetPending: true,
    })).toBe(true);
  });

  it("enables Send once the branch is known", () => {
    expect(isComposerSendButtonDisabled({
      ...disabledArgs,
      isAgentRunning: false,
      hasContent: true,
      targetPending: false,
    })).toBe(false);
  });

  it("keeps Stop enabled for a running parent thread while a fork waits for its branch", () => {
    expect(isComposerSendButtonDisabled({ ...disabledArgs, targetPending: true })).toBe(false);
  });
});

describe("composer send button while the thread is starting", () => {
  const starting = { ...disabledArgs, startingThread: true, isAgentRunning: false } as const;

  it("shows Stop, never Send, even with typed content", () => {
    for (const hasContent of [false, true]) {
      const state = getComposerSendButtonVisualState({ startingThread: true, isAgentRunning: false, isStopPending: false, hasContent });
      expect(state).toBe("starting");
      expect(SEND_BUTTON_VARIANT[state]).toBe("ink");
    }
  });

  it("keeps Stop enabled while the startup can be cancelled", () => {
    expect(isComposerSendButtonDisabled({ ...starting, canCancelStartup: true })).toBe(false);
    expect(isComposerSendButtonDisabled({ ...starting, hasContent: true, canCancelStartup: true })).toBe(false);
  });

  it("disables Stop once cancellation is requested", () => {
    expect(isComposerSendButtonDisabled({ ...starting, canCancelStartup: false })).toBe(true);
  });
});

describe("composer Stop colour", () => {
  it("renders Stop and Stopping as the neutral ink circle, never primary or destructive", () => {
    const stopStates = (["stop", "stopping"] as const).map((isStopPending) =>
      getComposerSendButtonVisualState({
        startingThread: false,
        isAgentRunning: true,
        isStopPending: isStopPending === "stopping",
        hasContent: false,
      }));
    expect(stopStates.map((state) => SEND_BUTTON_VARIANT[state])).toEqual(["ink", "ink"]);
  });
});
