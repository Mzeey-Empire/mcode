import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeChildProcess from "node:child_process";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import which from "which";
import { getDefaultSettings, type TurnRequest } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ProviderHostPorts } from "../../../host-ports.js";
import { AcpSessionRuntime } from "../../protocols/acp/acp-session-runtime.js";
import type { AcpPermissionOutcome, AcpPermissionRequest } from "../../protocols/acp/acp-session-types.js";
import { DevinProvider } from "../devin-provider.js";

vi.mock("which", () => ({ default: vi.fn() }));
const whichMock = vi.mocked(which as unknown as (cmd: string) => Promise<string | null>);

interface CapturedAcpCallbacks {
  onPermissionRequest?: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
  onSessionUpdate?: (update: unknown) => Promise<void>;
  readTextFile?: (path: string) => Promise<{ content: string } | string>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
}

interface FakeRuntime {
  runtime: AcpSessionRuntime;
  child: NodeChildProcess.ChildProcess;
  connection: ClientSideConnection & {
    authenticate: ReturnType<typeof vi.fn>;
    newSession: ReturnType<typeof vi.fn>;
    loadSession: ReturnType<typeof vi.fn>;
    setSessionConfigOption: ReturnType<typeof vi.fn>;
  };
  callbacks: CapturedAcpCallbacks;
}

function createHost(): ProviderHostPorts {
  return {
    runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
    environment: { snapshot: vi.fn(() => ({ WINDSURF_API_KEY: "test-key" })) },
    processes: {
      attach: vi.fn(),
      terminateTree: vi.fn(async () => undefined),
    },
    browser: {
      stage: vi.fn(() => ({ leaseId: "lease", expiresAt: Date.now() + 60_000 })),
      releaseSession: vi.fn(() => 0),
      isConfigured: vi.fn(() => false),
      issue: vi.fn(() => null),
      refresh: vi.fn(() => ({ ok: false as const, leaseId: "lease", reason: "unconfigured" as const })),
      release: vi.fn(() => ({ leaseId: "lease", released: false })),
      revokeCredential: vi.fn(() => false),
    },
    threadControl: {
      bootstrap: vi.fn(async () => null),
      close: vi.fn(async () => undefined),
    },
    grants: { consume: vi.fn(() => false) },
    events: {
      submit: vi.fn(async () => ({
        commit: {
          outcome: "committed" as const,
          conversationRevision: 1,
          rosterRevision: 1,
          acceptedThrough: 1,
          durableThrough: 1,
          eventCount: 1,
        },
        delivery: { ingress: "queued" as const },
      })),
    },
  };
}

function createFakeRuntime(sessionId: string, pid: number): FakeRuntime {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    stderr: new NodeEvents.EventEmitter(),
  }) as unknown as NodeChildProcess.ChildProcess;
  const callbacks: CapturedAcpCallbacks = {};
  const connection = {
    authenticate: vi.fn(async () => ({})),
    newSession: vi.fn(async () => ({ sessionId })),
    loadSession: vi.fn(async () => ({ sessionId })),
    setSessionConfigOption: vi.fn(async () => ({})),
  } as unknown as FakeRuntime["connection"];
  const runtime = {
    state: { child, connection, sessionId: "" },
    initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
    openSession: vi.fn(async ({ resumeFrom, cwd }: { resumeFrom?: string; cwd?: string }) => {
      if (resumeFrom) {
        const loaded = await connection.loadSession({ sessionId: resumeFrom, cwd, mcpServers: [] });
        runtime.state.sessionId = loaded.sessionId ?? resumeFrom;
        return { sessionId: runtime.state.sessionId, reloaded: true };
      }
      const created = await connection.newSession({ cwd, mcpServers: [] });
      runtime.state.sessionId = created.sessionId;
      return { sessionId: created.sessionId, reloaded: false };
    }),
    prompt: vi.fn(async () => ({
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 5 },
    })),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as AcpSessionRuntime;
  return { runtime, child, connection, callbacks };
}

/** Installs an AcpSessionRuntime.start spy that returns each fake in order. */
function mockAcpStart(runtimes: FakeRuntime[]) {
  return vi.spyOn(AcpSessionRuntime, "start").mockImplementation(async (options) => {
    const fake = runtimes.shift();
    if (!fake) throw new Error("Unexpected Devin ACP spawn");
    fake.callbacks.onPermissionRequest = options.callbacks.onPermissionRequest;
    fake.callbacks.onSessionUpdate = options.callbacks.onSessionUpdate;
    fake.callbacks.readTextFile = options.callbacks.readTextFile;
    fake.callbacks.writeTextFile = options.callbacks.writeTextFile;
    return fake.runtime;
  });
}

function turn(overrides: Partial<TurnRequest<"devin">> = {}): TurnRequest<"devin"> {
  return {
    turnId: "turn-1",
    turnExecutionId: "execution-1",
    sessionId: "mcode-thread-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    message: "do the thing",
    cwd: NodeOS.tmpdir(),
    model: "swe-2",
    permissionMode: "default",
    approvalReviewMode: "manual",
    interactionMode: "build",
    providerOptions: {},
    ...overrides,
  };
}

function submittedRuntimeEvents(host: ProviderHostPorts): Record<string, unknown>[] {
  return vi.mocked(host.events.submit).mock.calls.flatMap(([batch]) =>
    batch.events.map((draft) =>
      (draft.payload as { item: { payload: { runtimeEvent: { event: Record<string, unknown> } } } })
        .item.payload.runtimeEvent.event,
    ),
  );
}

async function textChunk(
  runtime: FakeRuntime,
  sessionId: string,
  text: string,
): Promise<void> {
  await runtime.callbacks.onSessionUpdate?.({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

describe("DevinProvider", () => {
  let provider: DevinProvider | undefined;
  const starts: MockInstance[] = [];

  beforeEach(() => {
    whichMock.mockResolvedValue("devin");
  });

  afterEach(async () => {
    for (const spy of starts) spy.mockRestore();
    starts.length = 0;
    await provider?.shutdown();
    provider = undefined;
  });

  function createProvider(host: ProviderHostPorts): DevinProvider {
    provider = new DevinProvider(host, {
      settings: { get: () => getDefaultSettings() },
    }, 60_000);
    return provider;
  }

  it("authenticates the ACP host with windsurf-api-key and _meta.api_key", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    createProvider(host);

    await provider!.sendTurn(turn());

    expect(fake.connection.authenticate).toHaveBeenCalledWith({
      methodId: "windsurf-api-key",
      _meta: { headless: true, api_key: "test-key" },
    });
  });

  it("opens a session, prompts, and publishes cursor + terminal events", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    createProvider(host);

    let resolvePrompt!: (value: unknown) => void;
    vi.mocked(fake.runtime.prompt).mockImplementation(
      async () => await new Promise((resolve) => { resolvePrompt = resolve; }),
    );

    const sending = provider!.sendTurn(turn());
    await vi.waitFor(() => expect(fake.runtime.prompt).toHaveBeenCalledOnce());
    await textChunk(fake, "devin-acp-1", "streamed reply");
    resolvePrompt({ stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 5 } });
    await sending;

    expect(fake.connection.newSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: NodeOS.tmpdir(), mcpServers: [] }),
    );
    const events = submittedRuntimeEvents(host);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "system", subtype: "sdk_session_id:devin-acp-1" }),
      expect.objectContaining({ type: "textDelta", delta: "streamed reply" }),
      expect.objectContaining({ type: "message", content: "streamed reply" }),
      expect.objectContaining({ type: "turnComplete", tokensIn: 3, tokensOut: 5 }),
      expect.objectContaining({ type: "ended", turnExecutionId: "execution-1" }),
    ]));
  });

  it("resumes through session/load when resumeFrom carries an ACP session id", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    createProvider(host);

    await provider!.sendTurn(turn({ resumeFrom: "saved-acp-session" }));

    expect(fake.runtime.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ resumeFrom: "saved-acp-session" }),
    );
    expect(fake.connection.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "saved-acp-session" }),
    );
    expect(fake.connection.newSession).not.toHaveBeenCalled();
  });

  it("applies model and native mode through session/set_config_option, restoring the prior mode after plan", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    createProvider(host);

    await provider!.sendTurn(turn({ providerOptions: { mode: "smart" } }));
    await provider!.sendTurn(turn({ interactionMode: "plan" }));
    await provider!.sendTurn(turn({ providerOptions: { mode: "smart" } }));

    const modeCalls = fake.connection.setSessionConfigOption.mock.calls
      .filter(([args]) => (args as { configId: string }).configId === "mode")
      .map(([args]) => (args as { value: string }).value);
    expect(modeCalls).toEqual(["smart", "plan", "smart"]);

    const modelCalls = fake.connection.setSessionConfigOption.mock.calls
      .filter(([args]) => (args as { configId: string }).configId === "model");
    expect(modelCalls).toHaveLength(1);
  });

  it("composes the wire model id from the family model and reasoning level", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    createProvider(host);

    await provider!.sendTurn(turn({ model: "swe-2", reasoningLevel: "medium" }));

    const modelCalls = fake.connection.setSessionConfigOption.mock.calls
      .filter(([args]) => (args as { configId: string }).configId === "model")
      .map(([args]) => (args as { value: string }).value);
    expect(modelCalls).toEqual(["swe-2-medium"]);
  });

  it("passes provider-native permission options through and resolves them by optionId", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    const p = createProvider(host);
    const permissionEvents: unknown[] = [];
    const resolvedEvents: unknown[] = [];
    p.on("permission_request", (request) => permissionEvents.push(request));
    p.on("permission_resolved", (event) => resolvedEvents.push(event));

    vi.mocked(fake.runtime.prompt).mockImplementation(async () => {
      const outcome = await fake.callbacks.onPermissionRequest?.({
        sessionId: "devin-acp-1",
        toolCall: { toolCallId: "tc-perm", title: "Bash", _meta: { "cognition.ai/editableCommand": "rm -rf build" } },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      } as AcpPermissionRequest);
      expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
      return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const sending = p.sendTurn(turn());
    await vi.waitFor(() => expect(permissionEvents).toHaveLength(1));
    const request = permissionEvents[0] as {
      requestId: string;
      options: { id: string; label: string; kind?: string }[];
      input: Record<string, unknown>;
    };
    expect(request.options).toEqual([
      { id: "allow_once", label: "Allow once", kind: "allow_once" },
      { id: "reject_once", label: "Reject", kind: "reject_once" },
    ]);
    expect(request.input).toMatchObject({ command: "rm -rf build" });

    expect(p.resolvePermission(request.requestId, "allow", undefined, "reject_once")).toBe(true);
    await sending;
    expect(resolvedEvents).toEqual([{ requestId: request.requestId, decision: "deny", optionLabel: "Reject" }]);
  });

  it("auto-allows permission requests while bypass mode is active", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    const p = createProvider(host);
    const permissionEvents: unknown[] = [];
    p.on("permission_request", (request) => permissionEvents.push(request));

    vi.mocked(fake.runtime.prompt).mockImplementation(async () => {
      const outcome = await fake.callbacks.onPermissionRequest?.({
        sessionId: "devin-acp-1",
        toolCall: { toolCallId: "tc-perm" },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      } as AcpPermissionRequest);
      expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
      return { stopReason: "end_turn", usage: {} };
    });

    await p.sendTurn(turn({ providerOptions: { mode: "bypass" } }));
    expect(permissionEvents).toEqual([]);
  });

  it("scopes ACP file reads and writes to the session worktree", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    const p = createProvider(host);
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "devin-acp-"));

    vi.mocked(fake.runtime.prompt).mockImplementation(async () => {
      await expect(fake.callbacks.readTextFile?.("../escape.txt")).rejects.toThrow("outside workspace");
      await expect(
        fake.callbacks.writeTextFile?.("../escape.txt", "nope"),
      ).rejects.toThrow("outside workspace");
      await fake.callbacks.writeTextFile?.("nested/inside.txt", "inside");
      const read = await fake.callbacks.readTextFile?.("nested/inside.txt");
      const content = typeof read === "string" ? read : read?.content;
      expect(content).toBe("inside");
      return { stopReason: "end_turn", usage: {} };
    });

    await p.sendTurn(turn({ cwd: root }));
    expect(NodeFS.readFileSync(NodePath.join(root, "nested", "inside.txt"), "utf-8")).toBe("inside");
    expect(NodeFS.existsSync(NodePath.join(root, "..", "escape.txt"))).toBe(false);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("serves the static model catalog without spawning when the devin binary is absent", async () => {
    const host = createHost();
    whichMock.mockResolvedValue(null);
    const startSpy = vi.spyOn(AcpSessionRuntime, "start");
    starts.push(startSpy);
    const p = createProvider(host);

    const models = await p.listModels();

    expect(startSpy).not.toHaveBeenCalled();
    expect(models.map((model) => model.id)).toContain("swe-2");
  });

  it("fails the turn without spawning when the devin binary is absent", async () => {
    const host = createHost();
    whichMock.mockResolvedValue(null);
    const startSpy = vi.spyOn(AcpSessionRuntime, "start");
    starts.push(startSpy);
    const p = createProvider(host);

    await expect(p.sendTurn(turn())).rejects.toThrow("Devin CLI not found");
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("skips access modes the session did not advertise while still applying plan", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    const p = createProvider(host);

    vi.mocked(fake.runtime.prompt).mockImplementation(async () => {
      await fake.callbacks.onSessionUpdate?.({
        sessionId: "devin-acp-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "mode",
              type: "select",
              options: [
                { value: "normal", name: "Normal" },
                { value: "bypass", name: "Bypass" },
              ],
            },
          ],
        },
      });
      return { stopReason: "end_turn", usage: {} };
    });

    await p.sendTurn(turn());
    await p.sendTurn(turn({ providerOptions: { mode: "smart" } }));
    await p.sendTurn(turn({ interactionMode: "plan" }));

    const modeCalls = fake.connection.setSessionConfigOption.mock.calls
      .filter(([args]) => (args as { configId: string }).configId === "mode")
      .map(([args]) => (args as { value: string }).value);
    expect(modeCalls).toEqual(["normal", "plan"]);
  });

  it("tracks switch_bypass so later prompts in the session auto-allow and the mode is not re-applied", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    const p = createProvider(host);
    const permissionEvents: { requestId: string }[] = [];
    p.on("permission_request", (request) => permissionEvents.push(request));

    let call = 0;
    vi.mocked(fake.runtime.prompt).mockImplementation(async () => {
      call += 1;
      const outcome = await fake.callbacks.onPermissionRequest?.({
        sessionId: "devin-acp-1",
        toolCall: { toolCallId: `tc-${call}` },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "switch_bypass", name: "Switch to Bypass", kind: "allow_always" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      } as AcpPermissionRequest);
      if (call === 1) {
        expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "switch_bypass" } });
      } else {
        // bypass is active session-side: no card, straight to the allow option.
        expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
      }
      return { stopReason: "end_turn", usage: {} };
    });

    const first = p.sendTurn(turn());
    await vi.waitFor(() => expect(permissionEvents).toHaveLength(1));
    expect(p.resolvePermission(permissionEvents[0].requestId, "allow", undefined, "switch_bypass")).toBe(true);
    await first;
    await p.sendTurn(turn({ providerOptions: { mode: "bypass" } }));

    expect(permissionEvents).toHaveLength(1);
    const modeCalls = fake.connection.setSessionConfigOption.mock.calls
      .filter(([args]) => (args as { configId: string }).configId === "mode")
      .map(([args]) => (args as { value: string }).value);
    expect(modeCalls).toEqual(["normal"]);
  });

  it("rejects permission resolution for unknown request ids and cancels pending requests on stop", async () => {
    const host = createHost();
    const fake = createFakeRuntime("devin-acp-1", 101);
    starts.push(mockAcpStart([fake]));
    const p = createProvider(host);
    const permissionEvents: { requestId: string }[] = [];
    p.on("permission_request", (request) => permissionEvents.push(request));

    vi.mocked(fake.runtime.prompt).mockImplementation(async () => {
      const outcome = await fake.callbacks.onPermissionRequest?.({
        sessionId: "devin-acp-1",
        toolCall: { toolCallId: "tc-perm" },
        options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
      } as AcpPermissionRequest);
      expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
      return { stopReason: "end_turn", usage: {} };
    });

    const sending = p.sendTurn(turn());
    await vi.waitFor(() => expect(permissionEvents).toHaveLength(1));
    expect(p.resolvePermission("unknown-id", "allow")).toBe(false);
    await p.stopSession("mcode-thread-1");
    await sending;
    expect(fake.runtime.cancel).toHaveBeenCalledOnce();
  });
});
