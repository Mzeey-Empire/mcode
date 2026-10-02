import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { CreateHookExecutionInput } from "../../events/persistence/hook-execution-repo.js";
import { PostTerminalHookCompletionEffect } from "../post-terminal-hook-completion-effect.js";

const THREAD_ID = "original-thread";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000124";
const HOOK: Omit<CreateHookExecutionInput, "messageId"> = {
  id: "original-hook", hookName: "Stop", toolName: null, phase: "stop", payload: "{}",
  durationMs: 42, didBlock: false, startedAt: "2026-09-30T19:09:40.000Z", endedAt: "2026-09-30T19:09:40.042Z", sortOrder: 9,
};

describe("PostTerminalHookCompletionEffect", () => {
  it("rejects a hook when accepted progress was not composed", () => {
    const effect = new PostTerminalHookCompletionEffect();
    expect(() => effect.schedule(THREAD_ID, HOOK, EXECUTION_ID)).toThrow("requires accepted progress composition");
  });

  it("rejects a missing captured execution identity before admission", () => {
    const effect = new PostTerminalHookCompletionEffect();
    const acceptLateHook = vi.fn();
    effect.bindAcceptedProgress({ acceptLateHook });
    expect(() => effect.schedule(THREAD_ID, HOOK, "")).toThrow("lacks its original execution identity");
    expect(acceptLateHook).not.toHaveBeenCalled();
  });

  it("immediately admits the exact captured hook and original execution", () => {
    const effect = new PostTerminalHookCompletionEffect();
    const acceptLateHook = vi.fn();
    effect.bindAcceptedProgress({ acceptLateHook });
    effect.schedule(THREAD_ID, HOOK, EXECUTION_ID);
    expect(acceptLateHook).toHaveBeenCalledExactlyOnceWith(THREAD_ID, EXECUTION_ID, HOOK);
    expect(acceptLateHook.mock.calls[0]?.[2]).toBe(HOOK);
  });

  it("surfaces admission rejection synchronously", () => {
    const effect = new PostTerminalHookCompletionEffect();
    const failure = new Error("Late hook requires its exact accepted terminal turn");
    const acceptLateHook = vi.fn(() => { throw failure; });
    effect.bindAcceptedProgress({ acceptLateHook });
    expect(() => effect.schedule(THREAD_ID, HOOK, EXECUTION_ID)).toThrow(failure);
    expect(acceptLateHook).toHaveBeenCalledExactlyOnceWith(THREAD_ID, EXECUTION_ID, HOOK);
  });
});
