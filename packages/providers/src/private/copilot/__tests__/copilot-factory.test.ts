import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotSession, PermissionRequest, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { ProviderRuntimeEventSchema, type TurnRequest } from "@mcode/contracts";
import { createCopilotProvider, type CopilotProviderBoundary, type ProviderHostPorts } from "../../../index.js";
import { DeterministicCanonicalSink } from "../../../conformance/deterministic-sink.js";
import { loadProviderFixtureManifest } from "../../../conformance/fixture-safety.js";
import * as NodeURL from "node:url";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const sdk = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), forceStop: vi.fn(), getState: vi.fn(), create: vi.fn(), resume: vi.fn(), models: vi.fn(), session: undefined as FakeSession | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock("@github/copilot-sdk", () => ({
  approveAll: () => ({ kind: "approved" }),
  CopilotClient: class {
    constructor() {}
    start = sdk.start;
    stop = sdk.stop;
    forceStop = sdk.forceStop;
    getState = sdk.getState;
    createSession = sdk.create;
    resumeSession = sdk.resume;
    listModels = sdk.models;
    rpc = { account: { getQuota: async () => ({ quotaSnapshots: {} }) } };
  },
}));

type NativeInput = { [K in SessionEvent["type"]]: Omit<Extract<SessionEvent, { type: K }>, "id" | "timestamp" | "parentId"> }[SessionEvent["type"]];
class FakeSession {
  constructor(readonly sessionId = "native-session") {}
  handlers = new Set<(event: SessionEvent) => void>();
  sequence = 0;
  on = (handler: (event: SessionEvent) => void): (() => void) => { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; };
  setModel = vi.fn(async (_model: string, _options?: Parameters<CopilotSession["setModel"]>[1]) => {});
  rpc = { mode: { set: vi.fn(async () => {}) }, plan: { read: vi.fn<CopilotSession["rpc"]["plan"]["read"]>(async () => ({ exists: false, content: null, path: null })) } };
  send = vi.fn(async () => "message");
  sendAndWait = vi.fn(async () => ({ data: { content: "utility result" } }));
  disconnect = vi.fn(async () => {});
  abort = vi.fn(async () => { this.emit({ type: "abort", data: { reason: "user initiated" } }); this.emit({ type: "session.idle", ephemeral: true, data: { aborted: true } }); });
  emit(input: NativeInput, id?: string): void {
    const sequence = ++this.sequence;
    const event: SessionEvent = { ...input, id: id ?? `native-event-${sequence}`, timestamp: "2026-10-02T10:00:00.000Z", parentId: sequence === 1 ? null : `native-event-${sequence - 1}` };
    this.handlers.forEach((handler) => handler(event));
  }
}

function request(overrides: Partial<TurnRequest<"copilot">> = {}): TurnRequest<"copilot"> {
  return { turnId: "turn-1", turnExecutionId: "00000000-0000-4000-8000-000000000001", sessionId: "mcode-thread-1", workspaceId: "fixture-workspace", threadId: "thread-1", message: "fixture message", cwd: "/fixture", model: "model", permissionMode: "full", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {}, ...overrides };
}
function host(sink: DeterministicCanonicalSink): ProviderHostPorts {
  return {
    runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
    environment: { snapshot: vi.fn(() => ({})) }, processes: { attach: vi.fn(), terminateTree: vi.fn(async () => {}) },
    browser: { stage: vi.fn(() => ({ leaseId: "lease", expiresAt: 1_000 })), releaseSession: vi.fn(() => 0), isConfigured: () => false, issue: () => null, refresh: (leaseId) => ({ ok: false, leaseId, reason: "not-found" }), release: (leaseId) => ({ leaseId, released: true }), revokeCredential: () => false },
    threadControl: { bootstrap: vi.fn(async () => null), close: vi.fn(async () => {}) },
    grants: { consume: vi.fn(() => false) }, events: sink,
  };
}
function projections(sink: DeterministicCanonicalSink) {
  return runtimeEvents(sink).map((runtime) => runtime.event);
}
function runtimeEvents(sink: DeterministicCanonicalSink) {
  return sink.snapshot().events.flatMap(({ payload }) => payload.type === "item.recorded" ? [ProviderRuntimeEventSchema().parse(payload.item.payload.runtimeEvent)] : []);
}

function shellPermission(identifiers = ["git status"], hasWriteFileRedirection = false): PermissionRequest {
  return {
    kind: "shell", fullCommandText: identifiers.join(" && "), intention: "Inspect the checkout",
    commands: identifiers.map((identifier) => ({ identifier, readOnly: true })),
    possiblePaths: [], possibleUrls: [], hasWriteFileRedirection, canOfferSessionApproval: true,
  };
}

describe("Copilot public factory", () => {
  let session: FakeSession;
  let sink: DeterministicCanonicalSink;
  let ports: ProviderHostPorts;
  let provider: CopilotProviderBoundary;
  let launch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    session = new FakeSession(); sdk.session = session;
    sdk.start.mockResolvedValue(undefined); sdk.stop.mockResolvedValue([]); sdk.forceStop.mockResolvedValue(undefined); sdk.getState.mockReturnValue("connected");
    sdk.create.mockResolvedValue(session); sdk.resume.mockResolvedValue(session);
    sdk.models.mockResolvedValue(["model", "other-model"].map((id) => ({ id, name: id, capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ["low", "high", "xhigh"], defaultReasoningEffort: "low" })));
    sink = new DeterministicCanonicalSink({ maxEvents: 2_000, maxDiagnostics: 32 }); ports = host(sink);
    launch = vi.fn(async () => ({ cliPath: "/copilot", env: {} }));
    provider = createCopilotProvider({ configuration: { cliPath: "copilot", idleSessionTtlMs: 600_000 }, host: ports, copilot: { launch: { resolve: launch } } });
  });
  afterEach(async () => { await provider.shutdown().catch(() => {}); });
  async function finish() {
    session.emit({ type: "session.idle", ephemeral: true, data: {} });
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  function pendingApproval() {
    const pending = provider.listPendingApprovals?.("thread-1") ?? [];
    expect(pending).toHaveLength(1);
    const [ask] = pending;
    if (!ask) throw new Error("Missing approval");
    return ask;
  }

  async function respond(requestId: string, choiceId: string) {
    if (!provider.resolveApproval) throw new Error("Provider cannot answer approvals");
    return provider.resolveApproval(requestId, { choiceId });
  }

  describe("native plans", () => {
    let home: string;
    let planRoot: string;
    let planPath: string;
    beforeEach(async () => {
      home = await NodeFSPromises.realpath(await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-copilot-plan-")));
      vi.mocked(NodeOS.homedir).mockReturnValue(home);
      planRoot = NodePath.join(home, ".copilot", "session-state", session.sessionId);
      planPath = NodePath.join(planRoot, "plan.md");
      await NodeFSPromises.mkdir(planRoot, { recursive: true });
    });
    afterEach(async () => {
      vi.mocked(NodeOS.homedir).mockReset();
      await NodeFSPromises.rm(home, { recursive: true, force: true });
    });

    it("permits only reads and this SDK session's exact plan file on every plan turn", async () => {
      for (let turn = 1; turn <= 2; turn++) {
        await provider.sendTurn(request({ interactionMode: "plan", turnId: `turn-${turn}`, turnExecutionId: `00000000-0000-4000-8000-00000000000${turn}` }));
        const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
        expect(options.configDir).toBe(NodePath.join(home, ".copilot"));
        const invocation = { sessionId: session.sessionId };
        expect(await options.onPermissionRequest({ kind: "read", fileName: NodePath.join(home, "source.ts") }, invocation)).toEqual({ kind: "approved" });
        expect(await options.onPermissionRequest({ kind: "write", fileName: planPath }, invocation)).toEqual({ kind: "approved" });
        const denied: PermissionRequest[] = [
          { kind: "write", fileName: NodePath.join(planRoot, "..", "another-session", "plan.md") },
          { kind: "write", fileName: NodePath.join(planRoot, "source.ts") },
          { kind: "write", fileName: `${planPath}.bak` },
          { kind: "write", fileName: "plan.md" },
          { kind: "write", path: planPath },
          { kind: "write", fileName: 42 },
          { kind: "shell", fullCommandText: "echo plan > plan.md" },
          { kind: "mcp", serverName: "writer", toolName: "write" },
          { kind: "url", url: "https://example.com" },
          { kind: "custom-tool", toolName: "write" },
        ];
        for (const permission of denied) expect(await options.onPermissionRequest(permission, invocation)).toEqual({ kind: "denied-by-rules", rules: [] });
        expect(await options.onPermissionRequest({ kind: "write", fileName: planPath }, { sessionId: "another-session" })).toEqual({ kind: "denied-by-rules", rules: [] });
        expect(provider.listPendingApprovals?.()).toEqual([]);
        await NodeFSPromises.writeFile(planPath, "abc");
        await finish();
      }
      expect(session.rpc.mode.set.mock.calls).toEqual([[{ mode: "plan" }], [{ mode: "plan" }]]);
    });

    it("denies a plan path redirected through a symlink", async () => {
      const outside = NodePath.join(home, "outside.md");
      await NodeFSPromises.writeFile(outside, "keep");
      await NodeFSPromises.symlink(outside, planPath, "file");
      await provider.sendTurn(request({ interactionMode: "plan" }));
      const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
      expect(await options.onPermissionRequest({ kind: "write", fileName: planPath }, { sessionId: session.sessionId })).toEqual({ kind: "denied-by-rules", rules: [] });
      await finish();
      expect(await NodeFSPromises.readFile(outside, "utf8")).toBe("keep");
    });

    it("uses COPILOT_HOME from the CLI launch environment for permissions and sync without a live session", async () => {
      const configDir = NodePath.join(home, "custom-copilot");
      const customRoot = NodePath.join(configDir, "session-state", session.sessionId);
      const customPath = NodePath.join(customRoot, "plan.md");
      await NodeFSPromises.mkdir(customRoot, { recursive: true });
      await NodeFSPromises.writeFile(customPath, "abc");
      launch.mockResolvedValue({ cliPath: "/copilot", env: { COPILOT_HOME: configDir } });
      const nativePlanFile = { path: customPath, sessionId: session.sessionId, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
      expect(await provider.prepareImplement?.({ threadId: "thread-1", markdown: "edited", nativePlanFile })).toEqual({ outcome: "synced" });
      expect(await NodeFSPromises.readFile(customPath, "utf8")).toBe("edited");
      session.rpc.plan.read.mockResolvedValue({ exists: true, content: "edited", path: customPath });
      await provider.sendTurn(request({ interactionMode: "plan", resumeFrom: session.sessionId }));
      const options: SessionConfig = sdk.resume.mock.calls[0]?.[1];
      expect(options.configDir).toBe(configDir);
      expect(await options.onPermissionRequest({ kind: "write", fileName: customPath }, { sessionId: session.sessionId })).toEqual({ kind: "approved" });
      expect(await options.onPermissionRequest({ kind: "write", fileName: planPath }, { sessionId: session.sessionId })).toEqual({ kind: "denied-by-rules", rules: [] });
      await finish();
      expect(runtimeEvents(sink).flatMap((event) => event.planCapture?.nativePlanFile ? [event.planCapture.nativePlanFile.path] : [])).toEqual([customPath]);
    });

    it("captures only changed native content across plan turns", async () => {
      const captured = vi.fn();
      provider.on("plan_captured", captured);
      for (const [index, content] of ["abc", "abc", "revised"].entries()) {
        if (index !== 1) await NodeFSPromises.writeFile(planPath, content);
        session.rpc.plan.read.mockResolvedValue({ exists: true, content, path: planPath });
        await provider.sendTurn(request({ interactionMode: "plan", turnId: `turn-${index + 1}`, turnExecutionId: `00000000-0000-4000-8000-00000000000${index + 1}` }));
        session.emit({ type: "assistant.message", data: { messageId: `message-${index}`, content: "Plan response" } });
        await finish();
        expect(captured).toHaveBeenCalledTimes(index === 2 ? 2 : 1);
      }
      expect(runtimeEvents(sink).flatMap((event) => event.planCapture ? [event.planCapture.markdown] : [])).toEqual(["abc", "revised"]);
    });

    it("captures native evidence before the canonical final message and reconciles only unchanged owned bytes", async () => {
      await NodeFSPromises.writeFile(planPath, "abc");
      session.rpc.plan.read.mockResolvedValue({ exists: true, content: "abc", path: planPath });
      const captured = vi.fn();
      provider.on("plan_captured", captured);
      await provider.sendTurn(request({ interactionMode: "plan" }));
      session.emit({ type: "assistant.message", data: { messageId: "plan-message", content: "The plan is ready." } });
      await finish();
      const nativePlanFile = { path: planPath, sessionId: "native-session", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
      expect(captured.mock.calls).toEqual([[{ threadId: "thread-1", markdown: "abc", source: "native", nativePlanFile }]]);
      expect(runtimeEvents(sink).filter((event) => event.planCapture).map((event) => ({ type: event.event.type, capture: event.planCapture }))).toEqual([
        { type: "message", capture: { markdown: "abc", source: "native", nativePlanFile } },
      ]);
      const input = { threadId: "thread-1", markdown: "edited", nativePlanFile };
      expect(await provider.prepareImplement?.({ ...input, nativePlanFile: { ...nativePlanFile, sessionId: "other" } })).toEqual({ outcome: "skipped", reason: "unsafe-path" });
      expect(await provider.prepareImplement?.(input)).toEqual({ outcome: "synced" });
      expect(await NodeFSPromises.readFile(planPath, "utf8")).toBe("edited");
      expect(await provider.prepareImplement?.({ ...input, markdown: "second edit" })).toEqual({ outcome: "skipped", reason: "changed" });
      expect(await NodeFSPromises.readFile(planPath, "utf8")).toBe("edited");
      expect(await NodeFSPromises.readdir(planRoot)).toEqual(["plan.md"]);
      session.rpc.plan.read.mockResolvedValue({ exists: true, content: "edited", path: planPath });
      await provider.sendTurn(request({ interactionMode: "plan", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
      await finish();
      expect(captured).toHaveBeenCalledTimes(1);
      expect(runtimeEvents(sink).flatMap((event) => event.planCapture ? [event.planCapture.markdown] : [])).toEqual(["abc"]);
    });

    it("reconciles a captured plan after idle eviction without starting another session", async () => {
      await NodeFSPromises.writeFile(planPath, "abc");
      session.rpc.plan.read.mockResolvedValue({ exists: true, content: "abc", path: planPath });
      await provider.sendTurn(request({ interactionMode: "plan" }));
      await finish();
      await provider.evictNonBusySessions("fixture idle eviction");
      const nativePlanFile = { path: planPath, sessionId: session.sessionId, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
      const input = { threadId: "thread-1", markdown: "edited after eviction", nativePlanFile };
      expect(await provider.prepareImplement?.(input)).toEqual({ outcome: "synced" });
      expect(await NodeFSPromises.readFile(planPath, "utf8")).toBe("edited after eviction");
      expect(await provider.prepareImplement?.(input)).toEqual({ outcome: "skipped", reason: "changed" });
      expect(await provider.prepareImplement?.({ ...input, nativePlanFile: null })).toEqual({ outcome: "skipped", reason: "no-file" });
      expect(sdk.create).toHaveBeenCalledOnce();
      expect(sdk.resume).not.toHaveBeenCalled();
    });

    it.each(["notes.md", "nested/plan.md"])("refuses a same-session reference to %s", async (name) => {
      const path = NodePath.join(planRoot, name);
      await NodeFSPromises.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSPromises.writeFile(path, "abc");
      const nativePlanFile = { path, sessionId: session.sessionId, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
      expect(await provider.prepareImplement?.({ threadId: "thread-1", markdown: "edit", nativePlanFile })).toEqual({ outcome: "skipped", reason: "unsafe-path" });
      expect(await NodeFSPromises.readFile(path, "utf8")).toBe("abc");
    });

    it("keeps valid native text but refuses a reported path outside this session", async () => {
      const outsideRoot = NodePath.join(home, ".copilot", "session-state", "other-session");
      await NodeFSPromises.mkdir(outsideRoot);
      const outsidePath = NodePath.join(outsideRoot, "plan.md");
      await NodeFSPromises.writeFile(outsidePath, "abc");
      session.rpc.plan.read.mockResolvedValue({ exists: true, content: "abc", path: outsidePath });
      const captured = vi.fn();
      provider.on("plan_captured", captured);
      await provider.sendTurn(request({ interactionMode: "plan" }));
      session.emit({ type: "assistant.message", data: { messageId: "plan-message", content: "The plan is ready." } });
      await finish();
      expect(captured.mock.calls).toEqual([[{ threadId: "thread-1", markdown: "abc", source: "native" }]]);
      expect(runtimeEvents(sink).flatMap((event) => event.planCapture ? [event.planCapture] : [])).toEqual([{ markdown: "abc", source: "native" }]);
      expect(await provider.prepareImplement?.({ threadId: "thread-1", markdown: "edit", nativePlanFile: { path: outsidePath, sessionId: session.sessionId, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" } })).toEqual({ outcome: "skipped", reason: "unsafe-path" });
      expect(await NodeFSPromises.readFile(outsidePath, "utf8")).toBe("abc");
    });

    it.each([null, "", "  ", "x".repeat(65_537)])("ignores missing or invalid native content %#", async (content) => {
      session.rpc.plan.read.mockResolvedValue({ exists: content !== null, content, path: planPath });
      const captured = vi.fn();
      provider.on("plan_captured", captured);
      await provider.sendTurn(request({ interactionMode: "plan" }));
      session.emit({ type: "assistant.message", data: { messageId: "plain-message", content: "No structured plan." } });
      await finish();
      expect(captured.mock.calls).toEqual([]);
      expect(runtimeEvents(sink).flatMap((event) => event.planCapture ? [event.planCapture] : [])).toEqual([]);
      expect(await provider.prepareImplement?.({ threadId: "thread-1", markdown: "edit", nativePlanFile: null })).toEqual({ outcome: "skipped", reason: "no-file" });
    });

    it("does not recapture a prior plan on a build turn", async () => {
      session.rpc.plan.read.mockResolvedValue({ exists: true, content: "abc", path: planPath });
      await provider.sendTurn(request());
      await finish();
      expect(session.rpc.plan.read.mock.calls).toEqual([]);
    });

    it("persists a native plan even when the SDK emits no final assistant message", async () => {
      session.rpc.plan.read.mockResolvedValue({ exists: true, content: "A native plan", path: null });
      await provider.sendTurn(request({ interactionMode: "plan" }));
      await finish();
      expect(runtimeEvents(sink).filter((event) => event.planCapture).map((event) => ({ event: event.event, capture: event.planCapture }))).toEqual([{
        event: { type: "message", threadId: "thread-1", turnExecutionId: "00000000-0000-4000-8000-000000000001", content: "A native plan", tokens: null },
        capture: { markdown: "A native plan", source: "native" },
      }]);
    });

    it("reports a failed plan read without publishing a successful turn completion", async () => {
      session.rpc.plan.read.mockRejectedValue(new Error("Plan read failed"));
      await provider.sendTurn(request({ interactionMode: "plan" }));
      await finish();
      expect(projections(sink).filter((event) => event.type === "turnComplete")).toEqual([]);
      expect(projections(sink).filter((event) => event.type === "error").map((event) => event.failure)).toEqual([{ kind: "fatal" }]);
      expect(projections(sink).at(-1)).toMatchObject({ type: "ended", outcome: "errored" });
      expect(runtimeEvents(sink).flatMap((event) => event.planCapture ? [event.planCapture] : [])).toEqual([]);
    });

    it("fences the transport when native plan capture exceeds its deadline", async () => {
      session.rpc.plan.read.mockImplementationOnce(() => new Promise(() => {}));
      await provider.sendTurn(request({ interactionMode: "plan" }));
      vi.useFakeTimers();
      try {
        session.emit({ type: "session.idle", ephemeral: true, data: {} });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(sdk.forceStop).toHaveBeenCalledOnce();
        expect(projections(sink).filter((event) => event.type === "turnComplete")).toEqual([]);
        expect(projections(sink).at(-1)).toMatchObject({ type: "ended", outcome: "errored" });
        await expect(provider.sendTurn(request({ resumeFrom: session.sessionId }))).rejects.toThrow("Copilot plan capture timed out");
        expect(sdk.resume).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });
  });

  it("keeps full native command scope and acknowledges a user denial", async () => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const native = options.onPermissionRequest({ kind: "shell", fullCommandText: "bun run lint", toolCallId: "call-1" }, { sessionId: session.sessionId });
    const pending = provider.listPendingApprovals?.("thread-1") ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.body).toMatchObject({ subject: { kind: "command", command: "bun run lint" }, toolCallId: "call-1", noteDelivery: "native" });
    expect(await provider.resolveApproval?.(pending[0]!.requestId, { choiceId: "deny" })).toEqual({ status: "resolved" });
    expect(await native).toEqual({ kind: "denied-interactively-by-user" });
    await finish();
  });

  it.each([false, true])("publishes write diffs and counts without rejecting oversized patches: %s", async (oversized) => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const diff = "--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1,2 @@\n-old\n+new\n+" + (oversized ? "x".repeat(262_144) : "second") + "\n";
    const native = options.onPermissionRequest({ kind: "write", fileName: "fixture.txt", diff, toolCallId: "edit-1" }, { sessionId: session.sessionId });
    const [pending] = provider.listPendingApprovals?.("thread-1") ?? [];
    expect(pending?.body).toMatchObject({ subject: { kind: "file_edit", files: [{
      path: "fixture.txt", change: "edited", additions: 2, deletions: 1,
      ...(oversized ? { patchTruncated: true } : { patch: "--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1,2 @@\n-old\n+new\n+second\n" }),
    }] } });
    if (oversized) expect(JSON.stringify(pending?.body)).not.toContain('"patch":');
    expect(await provider.resolveApproval?.(pending!.requestId, { choiceId: "deny" })).toEqual({ status: "resolved" });
    expect(await native).toEqual({ kind: "denied-interactively-by-user" });
    await finish();
  });

  it("publishes one session-stopped receipt before ending a pending permission", async () => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const native = options.onPermissionRequest({ kind: "shell", fullCommandText: "bun run lint", toolCallId: "call-1" }, { sessionId: session.sessionId });
    const [pending] = provider.listPendingApprovals?.() ?? [];
    if (!pending) throw new Error("Missing approval");
    await provider.stopSession("mcode-thread-1");
    await native;
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    const events = projections(sink);
    expect(events.filter((event) => event.type === "approvalDecided")).toEqual([{
      type: "approvalDecided", threadId: "thread-1", requestId: pending.requestId, turnExecutionId: "00000000-0000-4000-8000-000000000001",
      toolCallId: "call-1", kind: "command", subjectLabel: "bun run lint", origin: { kind: "agent" },
      outcome: { status: "cancelled", reason: "session_stopped" },
    }]);
    expect(events.findIndex((event) => event.type === "approvalDecided")).toBeLessThan(events.findIndex((event) => event.type === "ended"));
  });

  it("emits whole oversized commands and acknowledges the server's deny", async () => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const emitted = vi.fn();
    provider.on("approval_request", emitted);
    const oversized = options.onPermissionRequest({ kind: "shell", fullCommandText: "x".repeat(70_000) }, { sessionId: session.sessionId });
    const [large] = provider.listPendingApprovals?.() ?? [];
    if (!large) throw new Error("Expected an oversized approval");
    expect(large.body).toMatchObject({ subject: { kind: "command", command: "x".repeat(70_000) } });
    expect(emitted.mock.calls).toEqual([[large]]);
    expect(await provider.resolveApproval?.(large.requestId, { autoDeny: "too_large" })).toEqual({ status: "resolved" });
    expect(await oversized)
      .toEqual({ kind: "denied-no-approval-rule-and-could-not-request-from-user" });
    expect(provider.listPendingApprovals?.()).toEqual([]);
    await finish();
    expect(projections(sink).filter((event) => event.type === "approvalDecided").map((event) => event.outcome))
      .toEqual([{ status: "auto_denied", reason: "too_large" }]);
  });

  it("validates its own port and stays inert until the first public send", async () => {
    expect(() => createCopilotProvider({ configuration: { cliPath: "copilot", idleSessionTtlMs: 1 }, host: ports })).toThrow("launch.resolve");
    expect(launch).not.toHaveBeenCalled(); expect(sdk.start).not.toHaveBeenCalled();
    expect(ports.environment.snapshot).not.toHaveBeenCalled();
    await provider.sendTurn(request()); await finish();
    expect(sdk.start).toHaveBeenCalledOnce(); expect(sdk.create).toHaveBeenCalledOnce();
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: "/fixture", enableConfigDiscovery: true }));
    expect(sdk.create.mock.calls[0]?.[0]).not.toHaveProperty("customAgents");
  });

  it("reuses context while reapplying Plan/Build and changing Full to Supervised", async () => {
    await provider.sendTurn(request({ interactionMode: "plan" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    expect(await options.onPermissionRequest({ kind: "write", path: "/fixture/a" }, { sessionId: session.sessionId })).toEqual({ kind: "denied-by-rules", rules: [] });
    await finish();
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002", permissionMode: "supervised" }));
    const permission = options.onPermissionRequest({ kind: "shell", command: "touch a" }, { sessionId: session.sessionId });
    const pending = provider.listPendingApprovals?.("thread-1") ?? [];
    expect(pending).toHaveLength(1);
    expect(await provider.resolveApproval?.(pending[0]!.requestId, { choiceId: "deny" })).toEqual({ status: "resolved" });
    expect(await permission).toEqual({ kind: "denied-interactively-by-user" });
    await finish();
    expect(sdk.create).toHaveBeenCalledOnce();
    expect(session.rpc.mode.set.mock.calls).toEqual([[{ mode: "plan" }], [{ mode: "interactive" }]]);
  });

  it("keeps shell grants across turns without approving a write or a partly granted command", async () => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const permission = options.onPermissionRequest(shellPermission(), { sessionId: session.sessionId });
    const pending = pendingApproval();
    expect(pending.body.choices).toContainEqual({ id: "allow-session", intent: "allow_scoped", label: "Allow for this session", description: "Shell command identifiers: git status" });
    expect(await respond(pending.requestId, "allow-session")).toEqual({ status: "resolved" });
    expect(await permission).toEqual({ kind: "approved" });
    await finish();
    await provider.sendTurn(request({ permissionMode: "supervised", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
    expect(await options.onPermissionRequest(shellPermission(), { sessionId: session.sessionId })).toEqual({ kind: "approved" });
    expect(provider.listPendingApprovals?.("thread-1")).toEqual([]);
    for (const native of [
      { kind: "write", fileName: "/fixture/different", intention: "Edit a file", diff: "" } satisfies PermissionRequest,
      shellPermission(["git status", "rm"]),
      { ...shellPermission(), canOfferSessionApproval: false },
    ]) {
      const result = options.onPermissionRequest(native, { sessionId: session.sessionId });
      const ask = pendingApproval();
      expect(ask.body.subject.kind).toBe(native.kind === "write" ? "file_edit" : "command");
      await respond(ask.requestId, "deny");
      expect(await result).toEqual({ kind: "denied-interactively-by-user" });
    }
    vi.mocked(ports.grants.consume).mockReturnValueOnce(true);
    expect(await options.onPermissionRequest({ kind: "write", path: "/fixture/a" }, { sessionId: session.sessionId })).toEqual({ kind: "approved" });
    await finish();
  });

  it.each([true, undefined, "false"])("prompts despite a shell grant when file-write redirection is %j", async (hasWriteFileRedirection) => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const result = options.onPermissionRequest({ ...shellPermission(["git"]), fullCommandText: "git status" }, { sessionId: session.sessionId });
    await respond(pendingApproval().requestId, "allow-session");
    expect(await result).toEqual({ kind: "approved" });
    const redirected = options.onPermissionRequest({ ...shellPermission(["git"], true),
      fullCommandText: "git status > src/index.ts", hasWriteFileRedirection }, { sessionId: session.sessionId });
    const pending = pendingApproval();
    expect(pending.body.choices).toEqual([
      { id: "allow", intent: "allow_once", label: "Allow once" }, { id: "deny", intent: "deny", label: "Deny" },
    ]);
    await respond(pending.requestId, "deny");
    expect(await redirected).toEqual({ kind: "denied-interactively-by-user" });
    await finish();
  });

  it.each<{ name: string; initial: PermissionRequest; same: PermissionRequest; outside: PermissionRequest[]; description: string }>([
    { name: "URL origin", initial: { kind: "url", url: "https://example.com/a", intention: "Read docs" },
      same: { kind: "url", url: "https://example.com/b" },
      outside: [{ kind: "url", url: "https://other.example/a" }, { kind: "url", url: "https://example.com:8443/a" }, { kind: "url", url: "http://example.com/a" }],
      description: "URLs on origin: https://example.com" },
    { name: "MCP server and tool", initial: { kind: "mcp", serverName: "docs", toolName: "search", toolTitle: "Search", readOnly: true, args: { query: "one" } },
      same: { kind: "mcp", serverName: "docs", toolName: "search", args: { query: "two" } },
      outside: [{ kind: "mcp", serverName: "other", toolName: "search" }, { kind: "mcp", serverName: "docs", toolName: "write" }],
      description: "MCP server: docs; tool: search" },
  ])("matches only the stated $name scope", async ({ initial, same, outside, description }) => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const result = options.onPermissionRequest(initial, { sessionId: session.sessionId });
    const pending = pendingApproval();
    expect(pending.body.choices).toContainEqual({ id: "allow-session", intent: "allow_scoped", label: "Allow for this session", description });
    await respond(pending.requestId, "allow-session");
    expect(await result).toEqual({ kind: "approved" });
    expect(await options.onPermissionRequest(same, { sessionId: session.sessionId })).toEqual({ kind: "approved" });
    for (const native of outside) {
      const denied = options.onPermissionRequest(native, { sessionId: session.sessionId });
      const ask = pendingApproval();
      await respond(ask.requestId, "deny");
      expect(await denied).toEqual({ kind: "denied-interactively-by-user" });
    }
    await finish();
  });

  it.each<PermissionRequest>([
    { kind: "write", fileName: "/fixture/a" }, { kind: "read", path: "/fixture/a" },
    { kind: "custom-tool", toolName: "custom" },
    { ...shellPermission(), canOfferSessionApproval: false },
    { ...shellPermission(), commands: [] }, { ...shellPermission(), commands: [{ identifier: 42 }] },
    { ...shellPermission(), commands: [{ identifier: "x".repeat(500) }] },
    { kind: "url", url: "not a URL" }, { kind: "mcp", serverName: "docs" },
  ])("retains deny without inventing or truncating a scope: %j", async (native) => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const result = options.onPermissionRequest(native, { sessionId: session.sessionId });
    const [pending] = provider.listPendingApprovals?.() ?? [];
    expect(pending?.body.choices).toEqual([
      { id: "allow", intent: "allow_once", label: "Allow once" }, { id: "deny", intent: "deny", label: "Deny" },
    ]);
    if (!pending) throw new Error("Missing approval");
    expect(await provider.resolveApproval?.(pending.requestId, { choiceId: "allow-session" })).toMatchObject({ status: "failed" });
    await provider.resolveApproval?.(pending.requestId, { choiceId: "deny" });
    expect(await result).toEqual({ kind: "denied-interactively-by-user" });
    await finish();
  });

  it.each(["permission mode change", "session close"])("forgets grants after %s", async (reset) => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const result = options.onPermissionRequest(shellPermission(), { sessionId: session.sessionId });
    const pending = pendingApproval();
    await respond(pending.requestId, "allow-session");
    expect(await result).toEqual({ kind: "approved" });
    await finish();
    if (reset === "session close") await provider.discardSession?.("mcode-thread-1");
    else {
      await provider.sendTurn(request({ permissionMode: "full", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
      await finish();
    }
    await provider.sendTurn(request({ permissionMode: "supervised", turnId: "turn-3", turnExecutionId: "00000000-0000-4000-8000-000000000003" }));
    const currentOptions: SessionConfig = sdk.create.mock.calls.at(-1)?.[0];
    const denied = currentOptions.onPermissionRequest(shellPermission(), { sessionId: session.sessionId });
    const ask = pendingApproval();
    await respond(ask.requestId, "deny");
    expect(await denied).toEqual({ kind: "denied-interactively-by-user" });
    await finish();
  });

  it("updates model and reasoning on a pooled follow-up without losing history", async () => {
    await provider.sendTurn(request()); await finish();
    await provider.sendTurn(request({ model: "other-model", reasoningLevel: "max", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" })); await finish();
    expect(session.setModel).toHaveBeenCalledExactlyOnceWith("other-model", { reasoningEffort: "xhigh" });
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it("omits inherited reasoning for models that the native catalog marks unsupported", async () => {
    sdk.models.mockResolvedValueOnce([{ id: "model", name: "Model", capabilities: { supports: { reasoningEffort: false } } }, { id: "other-model", name: "Other", capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" }]);
    await provider.sendTurn(request({ reasoningLevel: "high" })); await finish();
    expect(sdk.create.mock.calls[0]?.[0].reasoningEffort).toBeUndefined();
    await provider.sendTurn(request({ model: "other-model", reasoningLevel: "high", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" })); await finish();
    expect(session.setModel).toHaveBeenCalledWith("other-model", { reasoningEffort: "low" });
  });

  it("replays the supported captured SDK envelopes through the actual factory and sink", async () => {
    const captured = loadProviderFixtureManifest(NodeURL.fileURLToPath(new URL("../../../conformance/fixtures/copilot-core.captured.json", import.meta.url)));
    const events = captured.input.copilotNativeEvents ?? [];
    expect(events.length).toBeGreaterThan(30);
    let turn = 1;
    await provider.sendTurn(request());
    for (const event of events) {
      session.handlers.forEach((handler) => handler(event));
      if (event.type !== "session.idle") continue;
      await vi.waitFor(() => expect(projections(sink).filter((projection) => projection.type === "ended")).toHaveLength(turn));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (event !== events.at(-1)) {
        turn++;
        await provider.sendTurn(request({ turnId: `captured-turn-${turn}`, turnExecutionId: `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}` }));
      }
    }
    expect(projections(sink).filter((event) => event.type === "ended").at(-1)).toMatchObject({ outcome: "cancelled" });
    const finalSnapshots = events.filter((event) => event.type === "assistant.message" && ["EVENT_30", "EVENT_47"].includes(event.id));
    expect(projections(sink).filter((event) => event.type === "message")).toEqual(finalSnapshots.map((event) => expect.objectContaining({ content: event.data.content })));
    const finalDrafts = sink.snapshot().events.filter((draft) => draft.payload.type === "item.recorded" && ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent).event.type === "message");
    expect(finalDrafts.map((draft) => draft.providerTimestamp)).toEqual(finalSnapshots.map((event) => event.timestamp));
    for (const [index, draft] of finalDrafts.entries()) {
      expect(draft.eventId).toContain(finalSnapshots[index]!.id);
      expect(JSON.stringify(draft)).toContain(`"predecessorEventId":"${finalSnapshots[index]!.parentId}"`);
    }
    expect(sink.snapshot().events.some((draft) => draft.eventId.includes("EVENT_17") && draft.payload.type === "item.recorded" && ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent).event.type === "assistantMessageBoundary")).toBe(true);
    expect(projections(sink).filter((event) => event.type === "textDelta").map((event) => event.delta).join("")).toContain("REDACTED_CONTENTREDACTED_CONTENTREDACTED_CONTENTREDACTED_CONTENT");
    const child = events.find((event) => event.type === "subagent.started");
    expect(sink.snapshot().events.some((event) => event.eventId.includes(child?.id ?? "missing"))).toBe(true);
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it("preserves a completed winner when stop races a slow canonical sink", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submit = sink.submit.bind(sink);
    ports.events = { submit: async (batch) => { await gate; return submit(batch); } };
    provider = createCopilotProvider({ configuration: { cliPath: "copilot", idleSessionTtlMs: 600_000 }, host: ports, copilot: { launch: { resolve: launch } } });
    await provider.sendTurn(request());
    session.emit({ type: "session.idle", ephemeral: true, data: {} });
    await provider.stopSession("mcode-thread-1");
    release();
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    expect(projections(sink).filter((event) => event.type === "turnComplete")).toEqual([expect.objectContaining({ reason: "end_turn" })]);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("keeps native timestamps/predecessors and child output outside the parent response", async () => {
    await provider.sendTurn(request());
    session.emit({ type: "subagent.started", data: { toolCallId: "child-invocation", agentName: "worker", agentDisplayName: "Worker", agentDescription: "fixture" } }, "child-start");
    session.emit({ type: "assistant.message", data: { messageId: "child-message", content: "private child output", parentToolCallId: "child-invocation" } });
    session.emit({ type: "assistant.message_delta", ephemeral: true, data: { messageId: "parent-message", deltaContent: "parent output" } }, "parent-delta");
    session.emit({ type: "subagent.completed", data: { toolCallId: "child-invocation", agentName: "worker", agentDisplayName: "Worker" } });
    await finish();
    expect(projections(sink).filter((event) => event.type === "message")).toEqual([]);
    expect(runtimeEvents(sink).filter((runtime) => runtime.event.type === "textDelta")).toMatchObject([
      { event: { delta: "private child output" }, extension: { providerId: "copilot", kind: "child-thread",
        childThread: { role: "child", path: ["child-invocation"], nativeItemId: "child-message", final: true } } },
      { event: { delta: "parent output" } },
    ]);
    expect(runtimeEvents(sink).filter((runtime) => !runtime.extension && runtime.event.type === "textDelta")
      .map((runtime) => runtime.event)).toEqual([expect.objectContaining({ delta: "parent output" })]);
    const native = sink.snapshot().events.find((event) => event.eventId.includes("parent-delta"));
    expect(native?.providerTimestamp).toBe("2026-10-02T10:00:00.000Z");
    expect(native?.sourceSequence).toBeUndefined();
    const child = sink.snapshot().events.find((event) => event.eventId.includes("child-start"));
    expect(child?.sourceIdentities).toContainEqual({ providerId: "copilot", scope: "item", value: "child-invocation", provenance: "native" });
    expect(JSON.stringify(child)).toContain('"predecessorEventId"');
  });

  it.each(["completed", "cancelled", "failed"] as const)("closes open children once when the parent is %s", async (outcome) => {
    await provider.sendTurn(request());
    for (let index = 0; index < 6; index += 1) session.emit({ type: "subagent.started", data: {
      toolCallId: `child-${index}`, agentName: "worker", agentDisplayName: "Worker", agentDescription: "Inspect",
    } });
    session.emit({ type: "subagent.completed", data: { toolCallId: "child-0", agentName: "worker", agentDisplayName: "Worker" } });
    if (outcome === "cancelled") await provider.stopSession("mcode-thread-1");
    else if (outcome === "failed") session.emit({ type: "session.error", data: { errorType: "fatal", message: "Native failed" } });
    else session.emit({ type: "session.idle", ephemeral: true, data: {} });
    await vi.waitFor(() => expect(runtimeEvents(sink).filter((runtime) => !runtime.extension).at(-1)?.event.type).toBe("ended"));
    const endings = runtimeEvents(sink).filter((runtime) => runtime.extension?.kind === "child-thread" && runtime.event.type === "ended");
    expect(endings.map((runtime) => runtime.extension)).toEqual([1, 2, 3, 4, 5].map((index) => ({
      providerId: "copilot", kind: "child-thread", childThread: { role: "child", path: [`child-${index}`] },
    })));
    expect(endings.map((runtime) => runtime.event)).toEqual([1, 2, 3, 4, 5].map(() => ({ type: "ended", threadId: "thread-1",
      turnExecutionId: request().turnExecutionId, outcome: outcome === "completed" ? "interrupted" : outcome === "cancelled" ? "cancelled" : "errored" })));
    const runtime = runtimeEvents(sink);
    const parentTerminal = runtime.findIndex((entry) => !entry.extension
      && ["turnComplete", "error", "ended"].includes(entry.event.type));
    expect(runtime.slice(parentTerminal).filter((entry) => entry.extension?.kind === "child-thread")).toEqual([]);
  });

  it("deduplicates native IDs and pairs tool starts/results in order", async () => {
    await provider.sendTurn(request());
    session.emit({ type: "tool.execution_start", data: { toolCallId: "tool", toolName: "read", arguments: {} } }, "tool-start");
    session.emit({ type: "tool.execution_start", data: { toolCallId: "tool", toolName: "read", arguments: {} } }, "tool-start");
    session.emit({ type: "tool.execution_complete", data: { toolCallId: "tool", success: true, result: { content: "result", detailedContent: "detail" } } });
    await finish();
    expect(projections(sink).filter((event) => event.type === "toolUse" || event.type === "toolResult")).toEqual([
      expect.objectContaining({ type: "toolUse", toolCallId: "tool" }), expect.objectContaining({ type: "toolResult", toolCallId: "tool", output: "detail" }),
    ]);
  });

  it("maps abort plus idle to one cancelled terminal and preserves follow-up context", async () => {
    await provider.sendTurn(request()); await provider.stopSession("mcode-thread-1");
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    expect(projections(sink).filter((event) => event.type === "ended")).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
    expect(JSON.stringify(sink.snapshot())).toContain('"type":"abort"');
    expect(session.disconnect).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" })); await finish();
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it("reports a Stop-fenced delivery failure without poisoning follow-up or provider shutdown", async () => {
    const submit = sink.submit.bind(sink);
    let fenced = false;
    sink.submit = async (batch) => {
      if (fenced) throw new Error("Canonical event execution is no longer admitted");
      return submit(batch);
    };
    const failure = vi.fn(async () => {});
    provider.setCanonicalTurnDeliveryFailureHandler(failure);
    await provider.sendTurn(request());
    await vi.waitFor(() => expect(sink.snapshot().events.length).toBeGreaterThan(0));
    fenced = true;
    await provider.stopSession(request().sessionId);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ executionId: request().turnExecutionId }), expect.objectContaining({ message: "Canonical event execution is no longer admitted" }));
    fenced = false;
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
    await finish();
    expect(sdk.create).toHaveBeenCalledOnce();
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it("settles a pending permission before a native error ends the turn", async () => {
    await provider.sendTurn(request({ permissionMode: "supervised" }));
    const options: SessionConfig = sdk.create.mock.calls[0]?.[0];
    const native = options.onPermissionRequest({ kind: "shell", fullCommandText: "bun run lint", toolCallId: "call-1" }, { sessionId: session.sessionId });
    session.emit({ type: "session.error", data: { errorType: "fatal", message: "native failed" } });
    expect(await native).toEqual({ kind: "denied-interactively-by-user" });
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    const types = projections(sink).map((event) => event.type);
    expect(projections(sink).filter((event) => event.type === "approvalDecided").map((event) => event.outcome))
      .toEqual([{ status: "cancelled", reason: "turn_ended" }]);
    expect(types.indexOf("approvalDecided")).toBeLessThan(types.indexOf("error"));
  });

  it("keeps a native error terminal failed when idle follows", async () => {
    await provider.sendTurn(request());
    session.emit({ type: "session.error", data: { errorType: "fatal", message: "native failed" } });
    session.emit({ type: "session.idle", ephemeral: true, data: {} });
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    expect(projections(sink).filter((event) => event.type === "ended")).toEqual([expect.objectContaining({ outcome: "errored" })]);
  });

  describe("after the Copilot CLI exits", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); });
    afterEach(() => { vi.useRealTimers(); });
    async function crashCli() {
      sdk.getState.mockReturnValue("disconnected");
      session.disconnect.mockRejectedValue(new Error("Connection is closed."));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    async function resumeOnFreshClient(endedBefore: number) {
      sdk.getState.mockReturnValue("connected");
      const replacement = new FakeSession(); sdk.resume.mockResolvedValueOnce(replacement);
      await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002", resumeFrom: session.sessionId }));
      replacement.emit({ type: "session.idle", ephemeral: true, data: {} });
      await vi.waitFor(() => expect(projections(sink).filter((event) => event.type === "ended")).toHaveLength(endedBefore + 1));
      expect(sdk.start).toHaveBeenCalledTimes(2);
      expect(sdk.resume).toHaveBeenCalledWith(session.sessionId, expect.anything());
      expect(projections(sink).at(-1)).toEqual(expect.objectContaining({ type: "ended", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
      expect(projections(sink).at(-1)).not.toHaveProperty("outcome");
    }

    it("fails the running turn instead of leaving it waiting for Stop", async () => {
      await provider.sendTurn(request());
      await crashCli();
      await vi.waitFor(() => expect(projections(sink).at(-1)).toEqual(expect.objectContaining({ type: "ended", outcome: "errored" })));
      expect(projections(sink)).toContainEqual(expect.objectContaining({ type: "error", error: "Copilot CLI disconnected" }));
      expect(sdk.forceStop).toHaveBeenCalledOnce();
      await resumeOnFreshClient(1);
    });

    it("drops an idle session bound to the dead client", async () => {
      await provider.sendTurn(request());
      await finish();
      await crashCli();
      await vi.waitFor(() => expect(sdk.forceStop).toHaveBeenCalledOnce());
      await resumeOnFreshClient(1);
    });
  });

  it("propagates durable resume failure without silently starting fresh", async () => {
    sdk.resume.mockRejectedValueOnce(new Error("native resume failed"));
    await expect(provider.sendTurn(request({ resumeFrom: "existing-native-session", resumeRequired: true }))).rejects.toMatchObject({
      message: expect.stringContaining("native resume failed"),
      failure: { kind: "fatal", code: "session_resume_unavailable" },
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("keeps an ordinary resume failure out of the seeded fallback", async () => {
    sdk.resume.mockRejectedValueOnce(new Error("native resume failed"));
    const sent = provider.sendTurn(request({ resumeFrom: "existing-native-session" }));
    await expect(sent).rejects.toThrow("native resume failed");
    await expect(sent).rejects.not.toMatchObject({ failure: { code: "session_resume_unavailable" } });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("rejects overlapping sends and fences callbacks retained after retirement", async () => {
    await provider.sendTurn(request());
    const late = [...session.handlers];
    await expect(provider.sendTurn(request({ turnExecutionId: "other" }))).rejects.toThrow("active turn");
    await finish(); const count = sink.snapshot().events.length;
    late.forEach((handler) => handler({ type: "assistant.message", id: "late", timestamp: "2026-10-02T10:00:00.000Z", parentId: null, data: { messageId: "late", content: "late" } }));
    expect(sink.snapshot().events).toHaveLength(count);
  });

  it("reports a rejected canonical sink to the exact server execution", async () => {
    const failure = vi.fn(async () => {}); provider.setCanonicalTurnDeliveryFailureHandler(failure);
    ports.events.submit = vi.fn(async () => { throw new Error("sink rejected"); });
    await provider.sendTurn(request());
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(expect.objectContaining({ executionId: "00000000-0000-4000-8000-000000000001" }), expect.objectContaining({ message: "sink rejected" })));
    expect(session.abort).toHaveBeenCalled();
  });

  it("stops a late spawn and rejects new turns during idempotent shutdown", async () => {
    let release!: (session: FakeSession) => void;
    sdk.create.mockImplementationOnce(() => new Promise<FakeSession>((resolve) => { release = resolve; }));
    const send = provider.sendTurn(request()); const rejected = expect(send).rejects.toBeDefined();
    await vi.waitFor(() => expect(sdk.create).toHaveBeenCalled());
    const shutdown = provider.shutdown();
    release(session);
    await rejected; await shutdown; await provider.shutdown();
    expect(session.disconnect).toHaveBeenCalledOnce(); expect(sdk.stop).toHaveBeenCalledOnce();
    await expect(provider.sendTurn(request())).rejects.toThrow("shutting down");
  });

  it("uses native discovery in isolated completion and awaits its runtime cleanup", async () => {
    expect(await provider.complete?.("utility", "model", "/fixture")).toBe("utility result");
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ enableConfigDiscovery: true, workingDirectory: "/fixture" }));
    expect(session.disconnect).toHaveBeenCalledOnce();
  });

  it("retires a session after abort rejection and permits a fresh follow-up", async () => {
    await provider.sendTurn(request());
    session.abort.mockRejectedValue(new Error("abort RPC failed"));
    await expect(provider.stopSession(request().sessionId)).rejects.toThrow("abort RPC failed");
    await vi.waitFor(() => expect(projections(sink).at(-1)).toEqual(expect.objectContaining({ type: "ended", outcome: "cancelled" })));
    expect(session.disconnect).toHaveBeenCalledOnce();
    const replacement = new FakeSession(); sdk.create.mockResolvedValueOnce(replacement);
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
    replacement.emit({ type: "session.idle", ephemeral: true, data: {} });
    await vi.waitFor(() => expect(projections(sink).filter((event) => event.type === "ended")).toHaveLength(2));
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });

  it("retires cancellation without native idle and fences old callbacks from the follow-up", async () => {
    await provider.sendTurn(request());
    const oldHandlers = [...session.handlers];
    session.abort.mockResolvedValue(undefined);
    await provider.stopSession(request().sessionId);
    expect(session.disconnect).toHaveBeenCalledOnce();
    const replacement = new FakeSession(); sdk.create.mockResolvedValueOnce(replacement);
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
    const count = projections(sink).filter((event) => event.type === "ended").length;
    oldHandlers.forEach((handler) => handler({ type: "session.idle", ephemeral: true, id: "late-old-idle", parentId: null, timestamp: "2026-10-02T10:00:00.000Z", data: {} }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(projections(sink).filter((event) => event.type === "ended")).toHaveLength(count);
    replacement.emit({ type: "session.idle", ephemeral: true, data: {} });
    await vi.waitFor(() => expect(projections(sink).filter((event) => event.type === "ended")).toHaveLength(count + 1));
  });

  it("cancels an outstanding utility RPC during shutdown and awaits its native close", async () => {
    session.sendAndWait.mockImplementationOnce(() => new Promise(() => {}));
    const completion = provider.complete!("utility", "model", "/fixture");
    const rejection = expect(completion).rejects.toBeDefined();
    await vi.waitFor(() => expect(session.sendAndWait).toHaveBeenCalled());
    await provider.shutdown(); await rejection;
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disconnect).toHaveBeenCalledOnce();
  });

  it("reserves terminal capacity when ordered canonical delivery overflows", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const submit = sink.submit.bind(sink);
    ports.events.submit = async (batch) => { await blocked; return submit(batch); };
    const failure = vi.fn(async () => {}); provider.setCanonicalTurnDeliveryFailureHandler(failure);
    await provider.sendTurn(request());
    for (let index = 0; index < 1_021; index += 1) session.emit({ type: "assistant.turn_start", data: { turnId: `native-turn-${index}` } });
    expect(session.abort).not.toHaveBeenCalled();
    session.emit({ type: "assistant.turn_start", data: { turnId: "overflow" } });
    expect(session.abort).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: expect.stringContaining("overflowed") })));
    const events = projections(sink);
    expect(events).toHaveLength(1_023);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "ended", outcome: "errored" }));
  });

  it("preserves native history while replacing permission-sensitive browser MCP configuration", async () => {
    const stage = vi.fn(() => ({ leaseId: "browser-lease", expiresAt: Date.now() + 60_000 }));
    const release = vi.fn((leaseId: string) => ({ leaseId, released: true }));
    ports.browser = { ...ports.browser, isConfigured: () => true, stage, release, issue: (handle) => ({ ...handle, credentialId: "browser-credential", token: "fixture-token", mcpUrl: "http://127.0.0.1/browser", allowedOperations: ["browser.list_tabs"] }) };
    ports.threadControl.bootstrap = vi.fn(async () => ({ name: "mcode", url: "http://127.0.0.1/thread-control", headers: { Authorization: "fixture-auth" } }));
    await provider.sendTurn(request()); await finish();
    expect(sdk.create.mock.calls[0]?.[0].mcpServers).toEqual(expect.objectContaining({ mcode: { type: "http", url: "http://127.0.0.1/thread-control", headers: { Authorization: "fixture-auth" }, tools: ["*"] } }));
    await provider.sendTurn(request({ interactionMode: "plan", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" })); await finish();
    expect(sdk.resume).toHaveBeenCalledWith(session.sessionId, expect.objectContaining({ enableConfigDiscovery: true, workingDirectory: "/fixture" }));
    expect(stage).toHaveBeenLastCalledWith(expect.objectContaining({ permissionCapability: "observe", providerSessionId: session.sessionId }));
    expect(release).toHaveBeenCalledOnce();
  });

  it("accumulates native usage once at idle and excludes thinking messages from response content", async () => {
    await provider.sendTurn(request());
    session.emit({ type: "session.usage_info", data: { tokenLimit: 100_000, currentTokens: 800, messagesLength: 1 } });
    session.emit({ type: "assistant.usage", data: { model: "model", inputTokens: 12, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 } });
    session.emit({ type: "assistant.usage", data: { model: "model", inputTokens: 15, outputTokens: 4 } });
    session.emit({ type: "assistant.message", data: { messageId: "thinking", phase: "thinking", content: "private reasoning" } });
    session.emit({ type: "assistant.message", data: { messageId: "response", phase: "response", content: "response" } });
    await finish();
    expect(projections(sink).filter((event) => event.type === "turnComplete")).toEqual([expect.objectContaining({ tokensIn: 27, tokensOut: 7, contextWindow: 100_000, totalProcessedTokens: 37 })]);
    expect(projections(sink).filter((event) => event.type === "message")).toEqual([expect.objectContaining({ content: "response" })]);
  });

  it("preserves stable drafts when replay falls outside the bounded native ID window", async () => {
    const replaySink = new DeterministicCanonicalSink({ maxEvents: 9_000, maxDiagnostics: 32 });
    ports.events = replaySink;
    provider = createCopilotProvider({ configuration: { cliPath: "copilot", idleSessionTtlMs: 600_000 }, host: ports, copilot: { launch: { resolve: launch } } });
    await provider.sendTurn(request());
    const original: SessionEvent = { id: "original-native-event", timestamp: "2026-10-02T10:00:00.000Z", parentId: null, type: "assistant.turn_start", data: { turnId: "original-native-turn" } };
    session.handlers.forEach((handler) => handler(original));
    for (let index = 0; index < 8_192; index += 1) {
      session.emit({ type: "assistant.turn_start", data: { turnId: `turn-${index}` } });
      if (index % 100 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const before = replaySink.snapshot().events.length;
    session.handlers.forEach((handler) => handler(original));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(replaySink.snapshot().events).toHaveLength(before);
    expect(replaySink.snapshot().diagnostics).toEqual([]);
    expect(session.abort).not.toHaveBeenCalled();
    session.emit({ type: "session.idle", ephemeral: true, data: {} });
    await vi.waitFor(() => expect(replaySink.snapshot().events.at(-1)?.payload).toEqual(expect.objectContaining({ type: "item.recorded", item: expect.objectContaining({ payload: expect.objectContaining({ runtimeEvent: expect.objectContaining({ event: expect.objectContaining({ type: "ended" }) }) }) }) })));
  });

  it("preserves nested native agent identity without copying notification prompts", async () => {
    await provider.sendTurn(request());
    session.emit({ type: "system.notification", data: { content: "private notification", kind: { type: "agent_completed", agentId: "native-background-agent", agentType: "task", status: "completed", description: "private task", prompt: "private prompt" } } }, "agent-notification");
    await finish();
    const notification = sink.snapshot().events.find((event) => event.eventId.includes("agent-notification"));
    expect(notification?.sourceIdentities).toContainEqual({ providerId: "copilot", scope: "agent", value: "native-background-agent", provenance: "native" });
    expect(notification?.payload).toMatchObject({ type: "item.recorded", item: { payload: { native: { data: { kind: { type: "agent_completed", agentId: "native-background-agent", agentType: "task", status: "completed" } } } } } });
    expect(JSON.stringify(notification)).not.toContain("private");
  });

  it("rejects malformed SDK tool arguments before admitting a durable tool event", async () => {
    await provider.sendTurn(request());
    const invalid = JSON.parse('{"id":"invalid-native-event","timestamp":"2026-10-02T10:00:00.000Z","parentId":null,"type":"tool.execution_start","data":{"toolCallId":"invalid-tool","toolName":"read","arguments":"invalid"}}');
    session.handlers.forEach((handler) => handler(invalid));
    await vi.waitFor(() => expect(projections(sink).at(-1)).toEqual(expect.objectContaining({ type: "ended", outcome: "errored" })));
    expect(projections(sink).filter((event) => event.type === "toolUse")).toEqual([]);
    expect(projections(sink)).toContainEqual(expect.objectContaining({ type: "error", error: "Malformed Copilot tool arguments" }));
  });

  it("joins concurrent stop requests and waits for the abort acknowledgement before reuse", async () => {
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
    session.abort.mockImplementationOnce(async () => {
      session.emit({ type: "abort", data: { reason: "user initiated" } });
      session.emit({ type: "session.idle", ephemeral: true, data: { aborted: true } });
      await acknowledged;
    });
    await provider.sendTurn(request());
    const first = provider.stopSession(request().sessionId);
    const second = provider.stopSession(request().sessionId);
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    await expect(provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }))).rejects.toThrow("active turn");
    expect(session.abort).toHaveBeenCalledOnce();
    acknowledge(); await first; await second;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" })); await finish();
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it.each([false, true])("publishes only the last parent snapshot at native idle (streamed=%s)", async (streamed) => {
    await provider.sendTurn(request());
    session.emit({ type: "assistant.turn_start", data: { turnId: "loop-1" } });
    session.emit({ type: "assistant.message", data: { messageId: "commentary", content: "Looking up the result." } });
    session.emit({ type: "assistant.turn_start", data: { turnId: "loop-2" } });
    if (streamed) session.emit({ type: "assistant.message_delta", ephemeral: true, data: { messageId: "answer", deltaContent: "Final " } });
    session.emit({ type: "assistant.message", data: { messageId: "child", content: "Child only", parentToolCallId: "child-invocation" } });
    session.emit({ type: "assistant.message", data: { messageId: "thinking", content: "Thinking only", phase: "thinking" } });
    session.emit({ type: "assistant.message", data: { messageId: "answer", content: "Final answer" } }, "final-snapshot");
    expect(projections(sink).filter((event) => event.type === "message")).toEqual([]);
    await finish();
    const events = projections(sink);
    expect(events.filter((event) => event.type === "message")).toEqual([expect.objectContaining({ content: "Final answer" })]);
    expect(events.filter((event) => event.type === "textDelta").map((event) => event.delta).join("")).toBe("Looking up the result.Final answer");
    expect(events.filter((event) => event.type === "assistantMessageBoundary")).toEqual([expect.objectContaining({ isFinalResponse: false })]);
    const messageIndex = events.findIndex((event) => event.type === "message");
    expect(messageIndex).toBeLessThan(events.findIndex((event) => event.type === "system" && event.subtype === "copilot_idle"));
    const draft = sink.snapshot().events.find((event) => event.eventId.includes("final-snapshot") && event.payload.type === "item.recorded" && ProviderRuntimeEventSchema().parse(event.payload.item.payload.runtimeEvent).event.type === "message");
    expect(draft?.providerTimestamp).toBe("2026-10-02T10:00:00.000Z");
    expect(JSON.stringify(draft)).toContain(`"predecessorEventId":"native-event-${session.sequence - 2}"`);
  });

  it("retains a later delta-only response without promoting an older model-loop snapshot", async () => {
    await provider.sendTurn(request());
    session.emit({ type: "assistant.turn_start", data: { turnId: "loop-1" } });
    session.emit({ type: "assistant.message", data: { messageId: "commentary", content: "Still working" } });
    session.emit({ type: "assistant.turn_start", data: { turnId: "loop-2" } });
    session.emit({ type: "assistant.message_delta", ephemeral: true, data: { messageId: "answer", deltaContent: "Later answer" } });
    await finish();
    expect(projections(sink).filter((event) => event.type === "message")).toEqual([]);
    expect(projections(sink).filter((event) => event.type === "assistantMessageBoundary")).toEqual([expect.objectContaining({ isFinalResponse: false }), expect.objectContaining({ isFinalResponse: true })]);
  });

  it.each(["abort", "error"] as const)("keeps a non-streamed partial snapshot when the native turn ends with %s", async (outcome) => {
    await provider.sendTurn(request());
    session.emit({ type: "assistant.message", data: { messageId: "partial", content: "Partial response" } });
    if (outcome === "abort") await provider.stopSession("mcode-thread-1");
    else session.emit({ type: "session.error", data: { errorType: "fixture", message: "Native failed" } });
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    const events = projections(sink);
    expect(events.filter((event) => event.type === "message")).toEqual([]);
    expect(events.filter((event) => event.type === "textDelta")).toEqual([expect.objectContaining({ delta: "Partial response" })]);
    expect(events.filter((event) => event.type === "assistantMessageBoundary")).toEqual([expect.objectContaining({ isFinalResponse: true })]);
    expect(events.at(-1)).toMatchObject({ outcome: outcome === "abort" ? "cancelled" : "errored" });
  });

  it("rejects a complete snapshot without a native message identity", async () => {
    await provider.sendTurn(request());
    const malformed = JSON.parse('{"type":"assistant.message","data":{"content":"Invalid body"},"id":"malformed-message","parentId":null,"timestamp":"2026-10-02T10:00:00.000Z"}');
    session.handlers.forEach((handler) => handler(malformed));
    await vi.waitFor(() => expect(projections(sink).at(-1)?.type).toBe("ended"));
    expect(projections(sink).filter((event) => event.type === "message")).toEqual([]);
    expect(projections(sink).filter((event) => event.type === "error")).toContainEqual(expect.objectContaining({ error: "Malformed Copilot assistant.message.messageId" }));
  });

  it.each(["missing", "malformed"])("retires a stopped session when fenced sink failure resolves the turn with %s native idle", async (idle) => {
    await provider.sendTurn(request());
    await vi.waitFor(() => expect(sink.snapshot().events).toHaveLength(1));
    const oldSession = session;
    const late = [...oldSession.handlers];
    const submit = sink.submit.bind(sink);
    ports.events.submit = async () => { throw new Error("Canonical event execution is no longer admitted"); };
    oldSession.abort.mockImplementationOnce(async () => {
      await Promise.resolve();
      oldSession.emit({ type: "abort", data: { reason: "user initiated" } });
      if (idle === "malformed") {
        const invalid = JSON.parse('{"id":"invalid-idle","timestamp":"2026-10-02T10:00:00.000Z","parentId":null,"type":"session.idle","data":{"aborted":"invalid"}}');
        oldSession.handlers.forEach((handler) => handler(invalid));
      }
    });
    await provider.stopSession(request().sessionId);
    expect(oldSession.abort).toHaveBeenCalledOnce();
    expect(oldSession.disconnect).toHaveBeenCalledOnce();
    ports.events.submit = submit;
    session = new FakeSession("replacement-native-session");
    sdk.create.mockResolvedValueOnce(session);
    const ended = projections(sink).filter((event) => event.type === "ended").length;
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
    late.forEach((handler) => handler({ id: "late-old-idle", timestamp: "2026-10-02T10:00:00.000Z", parentId: null, type: "session.idle", ephemeral: true, data: {} }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(projections(sink).filter((event) => event.type === "ended")).toHaveLength(ended);
    expect(session.send).toHaveBeenCalledOnce();
    await finish();
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });

  it.each(["model", "other-model"])("restores requested model/reasoning after %s controls acknowledge before mode failure", async (changedModel) => {
    let nativeModel = "model";
    let nativeReasoning: string | undefined;
    const dispatchedModels: string[] = [];
    session.setModel.mockImplementation(async (model, options) => { nativeModel = model; nativeReasoning = options?.reasoningEffort; });
    session.send.mockImplementation(async () => { dispatchedModels.push(nativeModel); return "message"; });
    await provider.sendTurn(request()); await finish();
    session.rpc.mode.set.mockRejectedValueOnce(new Error("Native mode selection failed"));
    await expect(provider.sendTurn(request({ model: changedModel, reasoningLevel: "high", permissionMode: "supervised", interactionMode: "plan", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }))).rejects.toThrow("Native mode selection failed");
    expect(nativeModel).toBe(changedModel);
    expect(nativeReasoning).toBe("high");
    await provider.sendTurn(request({ turnId: "turn-3", turnExecutionId: "00000000-0000-4000-8000-000000000003" })); await finish();
    expect(session.setModel.mock.calls).toEqual([[changedModel, { reasoningEffort: "high" }], ["model", { reasoningEffort: "low" }]]);
    expect(dispatchedModels).toEqual(["model", "model"]);
    expect(nativeModel).toBe("model");
    expect(nativeReasoning).toBe("low");
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it("retires a cancelled pending resume before a queued follow-up reuses its native identity", async () => {
    let resolveResume!: (value: FakeSession) => void;
    let resolveClose!: () => void;
    let nativeAlive = true;
    const order: string[] = [];
    const oldSession = new FakeSession();
    oldSession.disconnect.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { resolveClose = resolve; });
      nativeAlive = false;
      order.push("retire-old");
    });
    sdk.resume.mockImplementationOnce(() => new Promise<FakeSession>((resolve) => { resolveResume = resolve; }));
    sdk.resume.mockImplementationOnce(async () => { nativeAlive = true; order.push("resume-next"); return session; });
    session.send.mockImplementationOnce(async () => { if (!nativeAlive) throw new Error("Native session was destroyed"); return "message"; });
    const first = provider.sendTurn(request({ resumeFrom: oldSession.sessionId }));
    const rejection = expect(first).rejects.toBeDefined();
    await vi.waitFor(() => expect(sdk.resume).toHaveBeenCalledOnce());
    const stopping = provider.stopSession(request().sessionId);
    await rejection;
    const next = provider.sendTurn(request({ resumeFrom: oldSession.sessionId, turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sdk.resume).toHaveBeenCalledOnce();
    resolveResume(oldSession);
    await vi.waitFor(() => expect(oldSession.disconnect).toHaveBeenCalledOnce());
    expect(sdk.resume).toHaveBeenCalledOnce();
    resolveClose();
    await stopping; await next;
    expect(order).toEqual(["retire-old", "resume-next"]);
    session.emit({ type: "assistant.message", data: { messageId: "follow-up", content: "resumed response" } });
    await finish();
    expect(projections(sink)).toContainEqual(expect.objectContaining({ type: "message", content: "resumed response" }));
    expect(session.send).toHaveBeenCalledOnce();
  });

  it("waits for a cancelled resume rejection before the SDK can replace its native registry entry", async () => {
    let rejectResume!: (error: Error) => void;
    const order: string[] = [];
    sdk.resume.mockImplementationOnce(async () => {
      try { return await new Promise<FakeSession>((_resolve, reject) => { rejectResume = reject; }); }
      finally { order.push("remove-old-registration"); }
    });
    sdk.resume.mockImplementationOnce(async () => { order.push("resume-next"); return session; });
    const first = provider.sendTurn(request({ resumeFrom: session.sessionId }));
    const rejection = expect(first).rejects.toBeDefined();
    await vi.waitFor(() => expect(sdk.resume).toHaveBeenCalledOnce());
    const stopping = provider.stopSession(request().sessionId);
    await rejection;
    const next = provider.sendTurn(request({ resumeFrom: session.sessionId, turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sdk.resume).toHaveBeenCalledOnce();
    rejectResume(new Error("Native resume failed"));
    await stopping; await next;
    expect(order).toEqual(["remove-old-registration", "resume-next"]);
    await finish();
  });

  it("force-stops and fences the client when native resume exceeds its startup deadline", async () => {
    let resolveResume!: (value: FakeSession) => void;
    sdk.resume.mockImplementationOnce(() => new Promise<FakeSession>((resolve) => { resolveResume = resolve; }));
    vi.useFakeTimers();
    try {
      const first = provider.sendTurn(request({ resumeFrom: session.sessionId }));
      const rejection = expect(first).rejects.toThrow("Copilot session startup timed out");
      await vi.waitFor(() => expect(sdk.resume).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(sdk.forceStop).toHaveBeenCalledOnce();
      await expect(provider.sendTurn(request({ resumeFrom: session.sessionId }))).rejects.toThrow("Copilot session startup timed out");
      resolveResume(session);
      await Promise.resolve();
      expect(sdk.resume).toHaveBeenCalledOnce();
      expect(session.disconnect).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(["model", "mode"] as const)("joins cancelled native %s controls before retiring and resuming the session", async (control) => {
    await provider.sendTurn(request()); await finish();
    const oldSession = session;
    let resolveControl!: () => void;
    const pendingControl = new Promise<void>((resolve) => { resolveControl = resolve; });
    if (control === "model") oldSession.setModel.mockImplementationOnce(() => pendingControl);
    else oldSession.rpc.mode.set.mockImplementationOnce(() => pendingControl);
    const update = provider.sendTurn(request({ model: "other-model", interactionMode: "plan", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
    const rejection = expect(update).rejects.toBeDefined();
    await vi.waitFor(() => expect(control === "model" ? oldSession.setModel : oldSession.rpc.mode.set).toHaveBeenCalledTimes(control === "model" ? 1 : 2));
    const stopping = provider.stopSession(request().sessionId);
    await rejection;
    session = new FakeSession();
    const order: string[] = [];
    oldSession.disconnect.mockImplementationOnce(async () => { order.push("retire-old"); });
    sdk.resume.mockImplementationOnce(async () => { order.push("resume-next"); return session; });
    const next = provider.sendTurn(request({ resumeFrom: oldSession.sessionId, turnId: "turn-3", turnExecutionId: "00000000-0000-4000-8000-000000000003" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(oldSession.disconnect).not.toHaveBeenCalled();
    expect(sdk.resume).not.toHaveBeenCalled();
    resolveControl();
    await stopping; await next;
    expect(order).toEqual(["retire-old", "resume-next"]);
    expect(oldSession.send).toHaveBeenCalledOnce();
    expect(session.rpc.mode.set).toHaveBeenCalledWith({ mode: "interactive" });
    await finish();
  });

  it.each(["model", "mode"] as const)("fences native reuse after a %s control deadline", async (control) => {
    await provider.sendTurn(request()); await finish();
    let resolveControl!: () => void;
    const pendingControl = new Promise<void>((resolve) => { resolveControl = resolve; });
    if (control === "model") session.setModel.mockImplementationOnce(() => pendingControl);
    else session.rpc.mode.set.mockImplementationOnce(() => pendingControl);
    vi.useFakeTimers();
    try {
      const update = provider.sendTurn(request({ model: "other-model", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
      const rejection = expect(update).rejects.toThrow(`Copilot ${control} selection timed out`);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(sdk.forceStop).toHaveBeenCalledOnce();
      resolveControl();
      await Promise.resolve();
      await expect(provider.sendTurn(request({ resumeFrom: session.sessionId }))).rejects.toThrow(`Copilot ${control} selection timed out`);
      expect(session.send).toHaveBeenCalledOnce();
      expect(sdk.resume).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("keeps reuse fenced when delayed native destroy and public force-stop both fail their boundary", async () => {
    let resolveClose!: () => void;
    await provider.sendTurn(request()); await finish();
    session.disconnect.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
    sdk.forceStop.mockRejectedValueOnce(new Error("Native transport could not stop"));
    vi.useFakeTimers();
    try {
      const stopping = provider.evictNonBusySessions("fixture eviction");
      const rejection = expect(stopping).rejects.toThrow("Copilot native transport retirement failed");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      await expect(provider.sendTurn(request({ resumeFrom: session.sessionId }))).rejects.toThrow("Copilot session close timed out");
      resolveClose();
      await Promise.resolve();
      await expect(provider.sendTurn(request({ resumeFrom: session.sessionId }))).rejects.toThrow("Copilot session close timed out");
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(sdk.forceStop).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("fences another admitted session whose controls finish after native transport retirement", async () => {
    await provider.sendTurn(request()); await finish();
    const other = new FakeSession("other-native-session");
    let resolveControl!: () => void;
    other.rpc.mode.set.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveControl = resolve; }));
    sdk.create.mockResolvedValueOnce(other);
    let resolveClose!: () => void;
    session.disconnect.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
    vi.useFakeTimers();
    try {
      const next = provider.sendTurn(request({ sessionId: "mcode-thread-2", threadId: "thread-2", turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" }));
      const rejectedTurn = expect(next).rejects.toThrow("Copilot session close timed out");
      await vi.waitFor(() => expect(other.rpc.mode.set).toHaveBeenCalledOnce());
      const eviction = provider.evictNonBusySessions("fixture eviction");
      const rejectedEviction = expect(eviction).rejects.toThrow("Copilot session close timed out");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejectedEviction; await rejectedTurn;
      resolveControl(); resolveClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(other.send).not.toHaveBeenCalled();
      expect(sdk.forceStop).toHaveBeenCalledOnce();
      expect(projections(sink).filter((event) => event.threadId === "thread-2")).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
