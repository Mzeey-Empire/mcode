import { describe, it, expect, vi, beforeEach, afterEach, assert } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type { ApprovalRequestEnvelope } from "@mcode/contracts";

/**
 * Verifies the plan-file Read grant in ClaudeProvider.canUseTool (PRD #538):
 * a Read pre-granted via ScopedPreGrantService is auto-allowed without emitting
 * a approval_request, and all other tool calls fall through to the normal
 * permission flow unchanged.
 *
 * The fake SDK captures the `canUseTool` callback passed to query() so the test
 * can invoke it directly (the real SDK only calls it when the model requests a
 * tool, which this lightweight mock does not simulate).
 */
function makeFakeSdkQuery(captured: { canUseTool?: Function; finishTurn?: () => void }) {
  return ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<unknown>;
    options: Record<string, unknown>;
  }) => {
    captured.canUseTool = options.canUseTool as Function;
    const iterator = prompt[Symbol.asyncIterator]();
    const generator: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        const userMsg = await iterator.next();
        if (userMsg.done) {
          return { value: undefined as unknown as Record<string, unknown>, done: true };
        }
        await new Promise<void>((resolve) => { captured.finishTurn = resolve; });
        return {
          value: {
            type: "result",
            is_error: false,
            result: "ok",
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
          },
          done: false,
        };
      },
      async return() {
        return { value: undefined as unknown as Record<string, unknown>, done: true };
      },
      async throw(e: unknown) {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    Object.assign(generator, {
      setModel: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => captured.finishTurn?.()),
    });
    return generator;
  };
}

const { captured, mockQuery } = vi.hoisted(() => {
  const captured: { canUseTool?: Function; finishTurn?: () => void } = {};
  return { captured, mockQuery: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("@mcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcode/shared")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

import { ClaudeProvider } from "./helpers/provider-fixture.js";
import { ScopedPreGrantService } from "./helpers/provider-fixture.js";
import { stubEnvService } from "./helpers/provider-fixture.js";
import { stubJobObject } from "./helpers/provider-fixture.js";
import { mockProviderHostRuntime } from "./helpers/mock-sdk-query.js";

describe("ClaudeProvider scoped pre-grant (plan-file Read)", () => {
  let provider: ClaudeProvider;
  let scopedPreGrant: ScopedPreGrantService;

  beforeEach(() => {
    vi.clearAllMocks();
    captured.canUseTool = undefined;
    mockQuery.mockImplementation(makeFakeSdkQuery(captured));
    scopedPreGrant = new ScopedPreGrantService(mockProviderHostRuntime);
    provider = new ClaudeProvider(stubEnvService(), stubJobObject(), scopedPreGrant);
  });

  afterEach(async () => { await provider.shutdown(); });

  async function startTurn(threadId: string, cwd = process.cwd()): Promise<void> {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: `mcode-${threadId}`,
      threadId,
      message: "hello",
      cwd,
      model: "claude-sonnet-4-6",
      // supervised => SDK "default": tool calls would normally prompt.
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });
  }

  it("auto-allows a pre-granted Read without emitting a approval_request", async () => {
    const threadId = "thread-grant";
    const grantedPath = "/tmp/mcode-plan-thread-grant-123.md";
    scopedPreGrant.issue({ threadId, toolName: "Read", path: grantedPath });

    await startTurn(threadId);
    expect(captured.canUseTool).toBeTypeOf("function");

    const permissionEvents: unknown[] = [];
    provider.on("approval_request", (e) => permissionEvents.push(e));

    const result = await captured.canUseTool!("Read", { path: grantedPath }, {});
    expect(result).toEqual({ behavior: "allow", updatedInput: { path: grantedPath } });
    expect(permissionEvents).toHaveLength(0);
    // One-shot: the grant is consumed and not active afterwards.
    expect(scopedPreGrant.hasActiveGrant(threadId)).toBe(false);
  });

  it("does not bypass a Read of a different path (emits a approval_request)", async () => {
    const threadId = "thread-other";
    scopedPreGrant.issue({ threadId, toolName: "Read", path: "/tmp/granted.md" });

    await startTurn(threadId);
    const permissionEvents: unknown[] = [];
    provider.on("approval_request", (e) => permissionEvents.push(e));

    // Invoke with a non-granted path; the callback awaits a user decision, so
    // race it against a tick to confirm it emitted a request rather than
    // returning an immediate allow.
    const decision = captured.canUseTool!("Read", { path: "/tmp/other.md" }, {});
    await vi.waitFor(() => expect(permissionEvents).toHaveLength(1));
    void decision; // left pending; no resolution needed for this assertion
  });

  it.each([
    { toolName: "Edit", replaceAll: false }, { toolName: "Edit", replaceAll: true },
    { toolName: "Write", replaceAll: false }, { toolName: "MultiEdit", replaceAll: false },
  ])("publishes a real patch for native $toolName input (replace all: $replaceAll)", async ({ toolName, replaceAll }) => {
    const root = NodePath.resolve("../../.dev/fixture-repo");
    await NodeFSPromises.mkdir(root, { recursive: true });
    const cwd = await NodeFSPromises.mkdtemp(NodePath.join(root, "claude-approval-"));
    try {
      await NodeFSPromises.writeFile(NodePath.join(cwd, "fixture.txt"), replaceAll ? "old\nold\n" : "old\n");
      await startTurn("patch-thread", cwd);
      const input = toolName === "Write" ? { file_path: "fixture.txt", content: "new\n" }
        : toolName === "MultiEdit" ? { file_path: "fixture.txt", edits: [{ old_string: "old", new_string: "middle" }, { old_string: "middle", new_string: "new" }] }
        : { file_path: "fixture.txt", old_string: "old\n", new_string: "new\n", replace_all: replaceAll };
      const events: ApprovalRequestEnvelope[] = [];
      provider.on("approval_request", (event) => events.push(event));
      const decision = captured.canUseTool!(toolName, input, { toolUseID: "edit-1" });
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]?.body).toMatchObject({ toolCallId: "edit-1", subject: { kind: "file_edit", files: [{
        path: "fixture.txt", change: "edited", additions: replaceAll ? 2 : 1, deletions: replaceAll ? 2 : 1,
        patch: replaceAll
          ? "diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1,2 +1,2 @@\n-old\n-old\n+new\n+new\n"
          : "diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      }] } });
      assert(events[0]);
      expect(await provider.resolveApproval(events[0].requestId, { choiceId: "deny" })).toEqual({ status: "resolved" });
      expect(await decision).toMatchObject({ behavior: "deny" });
    } finally { await NodeFSPromises.rm(cwd, { recursive: true, force: true }); }
  });

  it("distinguishes an added file from unreadable, oversized, and escaping Write targets", async () => {
    const root = NodePath.resolve("../../.dev/fixture-repo");
    await NodeFSPromises.mkdir(root, { recursive: true });
    const fixture = await NodeFSPromises.mkdtemp(NodePath.join(root, "claude-boundary-"));
    const cwd = NodePath.join(fixture, "worktree");
    await NodeFSPromises.mkdir(cwd);
    await NodeFSPromises.mkdir(NodePath.join(fixture, "outside"));
    await NodeFSPromises.writeFile(NodePath.join(fixture, "outside", "secret.txt"), "private\n");
    await NodeFSPromises.writeFile(NodePath.join(cwd, "large.txt"), "x".repeat(1_048_577));
    await NodeFSPromises.symlink(NodePath.join(fixture, "outside"), NodePath.join(cwd, "linked"), "junction");
    try {
      await startTurn("boundary-thread", cwd);
      const events: ApprovalRequestEnvelope[] = [];
      provider.on("approval_request", (event) => events.push(event));
      for (const file of ["new.txt", "nested/new.txt", "large.txt", "../outside/secret.txt", "linked/secret.txt"]) {
        const decision = captured.canUseTool!("Write", { file_path: file, content: "new\n" }, {});
        await vi.waitFor(() => expect(events.at(-1)?.body).toMatchObject({ subject: { files: [{ path: file }] } }));
        const request = events.at(-1);
        assert(request);
        expect(request.body).toMatchObject({ subject: { kind: "file_edit", files: [file.endsWith("new.txt") ? {
          path: file, change: "added", additions: 1, deletions: 0,
          patch: file === "new.txt"
            ? "diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+new\n"
            : "diff --git a/nested/new.txt b/nested/new.txt\n--- /dev/null\n+++ b/nested/new.txt\n@@ -0,0 +1,1 @@\n+new\n",
        } : { path: file, change: "edited", additions: 0, deletions: 0, patchTruncated: true }] } });
        expect(JSON.stringify(request.body)).not.toContain("private");
        expect(await provider.resolveApproval(request.requestId, { choiceId: "deny" })).toEqual({ status: "resolved" });
        expect(await decision).toMatchObject({ behavior: "deny" });
      }
      const signal = new AbortController();
      const cancelled = captured.canUseTool!("Write", { file_path: "new.txt", content: "new\n" }, { signal: signal.signal });
      signal.abort();
      expect(await cancelled).toMatchObject({ behavior: "deny" });
      expect(events).toHaveLength(5);
    } finally { await NodeFSPromises.rm(fixture, { recursive: true, force: true }); }
  });
});
