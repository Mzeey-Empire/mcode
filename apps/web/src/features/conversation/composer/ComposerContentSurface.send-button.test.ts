import { describe, expect, it } from "vitest";
import {
  getComposerSendButtonVisualState,
  isComposerSendButtonDisabled,
} from "./ComposerContentSurface";

const disabledArgs = {
  needsWorkspace: false,
  providerReason: null,
  isStaleWorktree: false,
  planPending: false,
  isThreadScaffold: false,
  isAgentRunning: true,
  isStopPending: false,
  hasContent: false,
  setupBlocked: false,
} as const;

describe("composer send button stopping state", () => {
  it("shows a distinct stopping state while the stop request is in flight", () => {
    expect(getComposerSendButtonVisualState({
      isThreadScaffold: false,
      isAgentRunning: true,
      isStopPending: true,
      hasContent: false,
    })).toBe("stopping");
  });

  it("stays in stopping state even when the composer has queued content", () => {
    expect(getComposerSendButtonVisualState({
      isThreadScaffold: false,
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
      isThreadScaffold: false,
      isAgentRunning: true,
      isStopPending: false,
      hasContent: false,
    })).toBe("stop");
    expect(isComposerSendButtonDisabled({ ...disabledArgs, isStopPending: false })).toBe(false);
  });
});
