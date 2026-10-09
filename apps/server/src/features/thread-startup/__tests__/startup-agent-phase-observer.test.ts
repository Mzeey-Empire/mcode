import type { CanonicalAgentEvent, CanonicalAgentEventEnvelope, ThreadStartup, ThreadStartupError } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { StartupAgentPhaseObserver, type StartupAgentPhaseTransitions } from "../startup-agent-phase-observer.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000201";
const STARTUP_ID = "00000000-0000-4000-8000-000000000101";
const AT = "2026-10-09T12:00:00.000Z";

type Call = { kind: "complete" | "markCancelled" } | { kind: "fail"; error: ThreadStartupError };

class FakeStartups implements StartupAgentPhaseTransitions {
  readonly calls: Call[] = [];
  startup: ThreadStartup;

  constructor(state: ThreadStartup["state"] = "running", phase: ThreadStartup["phase"] = "agent") {
    this.startup = { startupId: STARTUP_ID, workspaceId: "workspace-1", kind: "direct", state, phase,
      steps: [{ phase: "thread", state: "completed", startedAt: AT, endedAt: AT },
        { phase: "agent", state: "running", startedAt: AT }],
      transcript: [], cancellation: "none", revision: 2, threadId: THREAD_ID, createdAt: AT, updatedAt: AT };
  }

  findByThreadId(threadId: string): ThreadStartup | null {
    return threadId === this.startup.threadId ? this.startup : null;
  }

  get(startupId: string): ThreadStartup | null {
    return startupId === this.startup.startupId ? this.startup : null;
  }

  async complete(): Promise<ThreadStartup> {
    this.calls.push({ kind: "complete" });
    return this.settle("completed");
  }

  async fail(_startupId: string, error: ThreadStartupError): Promise<ThreadStartup> {
    this.calls.push({ kind: "fail", error });
    return this.settle("failed");
  }

  async markCancelled(): Promise<ThreadStartup> {
    this.calls.push({ kind: "markCancelled" });
    return this.settle("cancelled");
  }

  private settle(state: ThreadStartup["state"]): ThreadStartup {
    this.startup = { ...this.startup, state };
    return this.startup;
  }
}

function harness(startups = new FakeStartups()) {
  let deliver: ((events: readonly CanonicalAgentEventEnvelope[]) => void) | undefined;
  const observer = new StartupAgentPhaseObserver(startups, (listener) => {
    deliver = listener;
    return () => { deliver = undefined; };
  });
  observer.start();
  const commit = async (...payloads: CanonicalAgentEvent[]) => {
    deliver?.(payloads.map((payload, index) => ({ eventId: `event-${index}`,
      routing: { threadId: THREAD_ID, turnId: "turn-1", executionId: "execution-1" }, sourceProviderId: "codex",
      sourceIdentities: [], acceptedSequence: index + 1, durableRevision: 1,
      serverTimestamps: { acceptedAt: AT, persistedAt: AT }, payload })));
    await observer.stop();
    observer.start();
  };
  return { startups, commit };
}

describe("StartupAgentPhaseObserver", () => {
  it("completes the startup when the provider sends its first frame", async () => {
    const { startups, commit } = harness();
    await commit({ type: "turn.provider-started", at: AT });

    expect(startups.calls).toEqual([{ kind: "complete" }]);
    expect(startups.startup.state).toBe("completed");
  });

  it("keeps the agent phase running while the turn has only started", async () => {
    const { startups, commit } = harness();
    await commit({ type: "turn.started", startedAt: AT });

    expect(startups.calls).toEqual([]);
    expect(startups.startup.state).toBe("running");
  });

  it("fails the startup with the provider error when the turn errors before any frame", async () => {
    const { startups, commit } = harness();
    await commit({ type: "turn.errored", endedAt: AT, error: `  ${"x".repeat(2_100)}  ` });

    expect(startups.calls).toEqual([{ kind: "fail", error: {
      code: "AGENT_START_FAILED", message: "Agent failed to start", retryable: true, detail: "x".repeat(2_000) } }]);
  });

  it("fails the startup when the turn is interrupted before any frame", async () => {
    const { startups, commit } = harness();
    await commit({ type: "turn.interrupted", endedAt: AT, reason: "Server restarted" });

    expect(startups.calls).toEqual([{ kind: "fail", error: { code: "AGENT_START_FAILED",
      message: "Agent was interrupted before it answered", retryable: true, detail: "Server restarted" } }]);
  });

  it("marks the startup cancelled when the turn is cancelled before any frame", async () => {
    const { startups, commit } = harness();
    await commit({ type: "turn.cancelled", endedAt: AT, reason: "User stopped" });

    expect(startups.calls).toEqual([{ kind: "markCancelled" }]);
    expect(startups.startup.state).toBe("cancelled");
  });

  it("applies only the first settling fact when one batch carries several", async () => {
    const { startups, commit } = harness();
    await commit({ type: "turn.provider-started", at: AT }, { type: "turn.errored", endedAt: AT, error: "late" });

    expect(startups.calls).toEqual([{ kind: "complete" }]);
  });

  it("leaves a settled startup unchanged when turn facts replay", async () => {
    const { startups, commit } = harness(new FakeStartups("completed"));
    await commit({ type: "turn.provider-started", at: AT }, { type: "turn.errored", endedAt: AT, error: "replayed" });

    expect(startups.calls).toEqual([]);
    expect(startups.startup.state).toBe("completed");
  });

  it("ignores turn facts while the startup is still preparing its worktree", async () => {
    const { startups, commit } = harness(new FakeStartups("running", "setup"));
    await commit({ type: "turn.provider-started", at: AT });

    expect(startups.calls).toEqual([]);
  });
});
