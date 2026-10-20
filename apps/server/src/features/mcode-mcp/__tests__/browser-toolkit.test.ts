import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_OPERATIONS,
  BrowserAutomationRequestSchema,
  type BrowserAutomationPublicOperation,
  type BrowserAutomationResponse,
  type BrowserAutomationResult,
} from "@mcode/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserAutomationCredentialClaims } from "../../browser-automation/index.js";
import type { McodeSession } from "../mcode-session-authority.js";
import { BrowserToolkit, type BrowserToolkitOptions } from "../toolkits/browser-toolkit.js";

const session: McodeSession = {
  providerId: "cursor",
  sessionId: "mcode-session",
  threadId: "thread-a",
  threadControl: false,
};

function claimsWith(overrides: Partial<BrowserAutomationCredentialClaims> = {}): BrowserAutomationCredentialClaims {
  return {
    credentialId: "credential-a",
    issuedAt: 0,
    expiresAt: 1_000_000,
    providerId: "cursor",
    providerSessionId: "provider-session",
    mcodeSessionId: "mcode-session",
    threadId: "thread-a",
    workspaceId: "workspace-a",
    worktreeIdentity: "worktree-a",
    permissionCapability: "privileged",
    allowedOperations: [...BROWSER_AUTOMATION_OPERATIONS],
    ...overrides,
  };
}

function responseFor(input: unknown, result: BrowserAutomationResult): BrowserAutomationResponse {
  const request = BrowserAutomationRequestSchema().parse(input);
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: request.requestId,
    sequence: request.sequence,
    ok: true,
    result,
  };
}

const inspectResult: BrowserAutomationResult = { operation: "inspect", controlEpoch: 0, tabs: [] };

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { claims?: BrowserAutomationCredentialClaims | null; maxSequenceEntries?: number } = {}) {
  const claims = options.claims === undefined ? claimsWith() : options.claims;
  const claimsFor = vi.fn<BrowserToolkitOptions["lease"]["claimsFor"]>(() => claims);
  const execute = vi.fn<BrowserToolkitOptions["broker"]["execute"]>(async (_claims, input) =>
    responseFor(input, inspectResult));
  const availableOperations = vi.fn<BrowserToolkitOptions["broker"]["availableOperations"]>(
    (forClaims) => forClaims.allowedOperations,
  );
  const cancelFromProvider = vi.fn<BrowserToolkitOptions["broker"]["cancelFromProvider"]>(() => false);
  const recordMcpLifecycle = vi.fn<BrowserToolkitOptions["broker"]["recordMcpLifecycle"]>();
  const toolkit = new BrowserToolkit({
    lease: { claimsFor },
    broker: { execute, availableOperations, cancelFromProvider, recordMcpLifecycle },
    now: () => 1_000,
    maxSequenceEntries: options.maxSequenceEntries,
  });

  function call(
    name: string,
    args: unknown = {},
    context: { toolCallId?: string; signal?: AbortSignal } = {},
  ): Promise<CallToolResult> {
    const tool = toolkit.bind(session)?.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool ${name} is not bound`);
    return tool.call(args, {
      toolCallId: context.toolCallId ?? "call-1",
      signal: context.signal ?? new AbortController().signal,
    });
  }

  const listed = (): string[] =>
    toolkit.bind(session)?.tools.filter((tool) => tool.listed).map((tool) => tool.name) ?? [];
  const requestAt = (index: number) => BrowserAutomationRequestSchema().parse(execute.mock.calls[index]?.[1]);

  return { toolkit, claimsFor, execute, availableOperations, cancelFromProvider, recordMcpLifecycle, call, listed, requestAt };
}

describe("BrowserToolkit", () => {
  it("lists the credential's core tools plus negotiated extras, and hides evaluate until negotiated", () => {
    const { listed, availableOperations, claimsFor } = setup();

    availableOperations.mockReturnValue([]);
    expect(listed()).toEqual(["browser_open", "browser_inspect", "browser_act", "browser_tabs"]);
    availableOperations.mockReturnValue(["evaluate"]);
    expect(listed()).toEqual(["browser_open", "browser_inspect", "browser_act", "browser_tabs", "browser_evaluate"]);
    expect(claimsFor).toHaveBeenCalledWith("cursor", "mcode-session");
  });

  it("lists only the operations an observe credential allows", () => {
    const { listed } = setup({ claims: claimsWith({ permissionCapability: "observe", allowedOperations: ["inspect"] }) });

    expect(listed()).toEqual(["browser_inspect"]);
  });

  it("binds nothing when the session has no live Browser claims", () => {
    const { toolkit } = setup({ claims: null });

    expect(toolkit.bind(session)).toBeNull();
  });

  it("publishes MCP safety annotations and the required fields providers rely on", () => {
    const tools = setup().toolkit.bind(session)?.tools ?? [];
    const named = (name: string) => tools.find((tool) => tool.name === name);

    expect(named("browser_inspect")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(named("browser_evaluate")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(named("browser_evaluate")?.inputSchema.required).toEqual([
      "idempotencyKey",
      "observationRef",
      "deadlineMs",
      "expression",
    ]);
    expect(tools.map((tool) => tool.name).join(" ")).not.toMatch(/browser_(status|navigate|snapshot|click|type)/);
  });

  it("refuses an operation the credential does not allow and evaluation without privilege", async () => {
    const observe = setup({ claims: claimsWith({ permissionCapability: "observe", allowedOperations: ["inspect"] }) });
    await expect(observe.call("browser_open", { idempotencyKey: "k", url: "https://example.com" }))
      .rejects.toMatchObject({ code: -32003, message: expect.stringContaining("Browser operation is forbidden") });

    const interact = setup({
      claims: claimsWith({ permissionCapability: "interact", allowedOperations: [...BROWSER_AUTOMATION_OPERATIONS] }),
    });
    await expect(interact.call("browser_evaluate", {}))
      .rejects.toMatchObject({ code: -32003, message: expect.stringContaining("Browser evaluation is forbidden") });
    expect(observe.execute).not.toHaveBeenCalled();
    expect(interact.execute).not.toHaveBeenCalled();
  });

  it("gates calls by the credential rather than live negotiation", async () => {
    const { call, availableOperations, execute } = setup();
    availableOperations.mockReturnValue([]);

    await call("browser_inspect");

    expect(execute).toHaveBeenCalledOnce();
  });

  it("binds the request to the credential scope and lifts the control epoch out of the arguments", async () => {
    const { call, requestAt, execute } = setup();

    await call("browser_inspect", { expectedControlEpoch: 4, includeDiagnostics: true });

    expect(execute.mock.calls[0]?.[0]).toMatchObject({ credentialId: "credential-a" });
    expect(requestAt(0)).toMatchObject({
      workspaceId: "workspace-a",
      threadId: "thread-a",
      providerSessionId: "provider-session",
      providerInstanceId: "mcode-session",
      operation: "inspect",
      expectedControlEpoch: 4,
      sequence: 1,
      deadline: 61_000,
      args: { includeDiagnostics: true },
    });
  });

  it("rejects caller-supplied scope and invalid argument shapes before the broker", async () => {
    const { call, execute } = setup();

    await expect(call("browser_inspect", { threadId: "thread-b" }))
      .rejects.toMatchObject({ code: -32602, message: expect.stringContaining("Invalid browser tool arguments") });
    await expect(call("browser_act", { idempotencyKey: "k", observationRef: "o", deadlineMs: 1_000, steps: [] }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(call("browser_tabs", { action: "select", idempotencyKey: "k", observationRef: "o" }))
      .rejects.toMatchObject({ code: -32602 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("routes a valid browser_tabs mutation", async () => {
    const { call, requestAt } = setup();

    await call("browser_tabs", { action: "select", tabId: "tab-2", idempotencyKey: "k", observationRef: "obs-1" });

    expect(requestAt(0)).toMatchObject({
      operation: "tabs",
      args: { action: "select", tabId: "tab-2", idempotencyKey: "k", observationRef: "obs-1" },
    });
  });

  it("projects inspect screenshots as image content without duplicating the base64 in text", async () => {
    const { call, execute } = setup();
    const data = "iVBORw0KGgo=";
    execute.mockImplementationOnce(async (_claims, input) => responseFor(input, {
      operation: "inspect",
      controlEpoch: 0,
      tabs: [],
      screenshot: { mediaType: "image/png", dataBase64: data, width: 320, height: 180, truncation: { truncated: false } },
    }));

    const result = await call("browser_inspect", { includeScreenshot: true });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).not.toContain(data);
    expect(JSON.parse(text)).toMatchObject({
      operation: "inspect",
      screenshot: { mediaType: "image/png", width: 320, height: 180 },
    });
    expect(result.content[1]).toEqual({ type: "image", data, mimeType: "image/png" });
  });

  it("keeps plain results and failures as one text block, flagging failures", async () => {
    const { call, execute } = setup();

    const plain = await call("browser_inspect");
    expect(plain.content).toEqual([{ type: "text", text: JSON.stringify(inspectResult) }]);
    expect(plain.isError).toBe(false);

    const error = { code: "HOST_UNAVAILABLE", message: "Browser host is unavailable", retryable: true } as const;
    execute.mockImplementationOnce(async (_claims, input) => {
      const request = BrowserAutomationRequestSchema().parse(input);
      return {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        requestId: request.requestId,
        sequence: request.sequence,
        ok: false,
        error,
      };
    });
    const failed = await call("browser_inspect");
    expect(failed.content).toEqual([{ type: "text", text: JSON.stringify(error) }]);
    expect(failed.isError).toBe(true);
  });

  it("refuses a result that exceeds the response limit with JSON-RPC -32002", async () => {
    const { call, execute } = setup();
    execute.mockImplementationOnce(async (_claims, input) => responseFor(input, {
      operation: "inspect",
      controlEpoch: 0,
      tabs: [],
      guidance: "x".repeat(BROWSER_AUTOMATION_MAX_RESULT_BYTES + 1),
    }));

    await expect(call("browser_inspect")).rejects.toMatchObject({
      code: -32002,
      message: expect.stringContaining("Browser result exceeds the response limit"),
    });
  });

  it("refuses a duplicate active request id and a full active-call table", async () => {
    const { call, execute } = setup({ maxSequenceEntries: 1 });
    const held = deferred<BrowserAutomationResponse>();
    execute.mockImplementationOnce(() => held.promise);

    const first = call("browser_inspect", {}, { toolCallId: "a" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await expect(call("browser_inspect", {}, { toolCallId: "a" }))
      .rejects.toMatchObject({ code: -32600, message: expect.stringContaining("already active") });
    await expect(call("browser_inspect", {}, { toolCallId: "b" }))
      .rejects.toMatchObject({ code: -32004, message: expect.stringContaining("capacity is exhausted") });

    held.resolve(responseFor(
      BrowserAutomationRequestSchema().parse(execute.mock.calls[0]?.[1]),
      inspectResult,
    ));
    await first;
    await expect(call("browser_inspect", {}, { toolCallId: "a" })).resolves.toMatchObject({ isError: false });
  });

  it("cancels the exact broker request when the call signal aborts", async () => {
    const { call, execute, cancelFromProvider, requestAt } = setup();
    const held = deferred<BrowserAutomationResponse>();
    execute.mockImplementationOnce(() => held.promise);
    const controller = new AbortController();

    const pending = call("browser_inspect", {}, { signal: controller.signal });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();

    expect(cancelFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "credential-a" }),
      requestAt(0).requestId,
      requestAt(0).sequence,
    );
    held.resolve(responseFor(requestAt(0), inspectResult));
    await pending;
  });

  it("numbers requests per credential and bounds that state with explicit release", async () => {
    const { call, requestAt, toolkit, claimsFor } = setup({ maxSequenceEntries: 1 });

    await call("browser_inspect", {}, { toolCallId: "1" });
    await call("browser_inspect", {}, { toolCallId: "2" });
    expect([requestAt(0).sequence, requestAt(1).sequence]).toEqual([1, 2]);

    claimsFor.mockReturnValue(claimsWith({ credentialId: "credential-b" }));
    await call("browser_inspect", {}, { toolCallId: "3" });

    expect(toolkit.releaseCredential("credential-a")).toBe(false);
    expect(toolkit.releaseCredential("credential-b")).toBe(true);
    expect(toolkit.releaseCredential("credential-b")).toBe(false);
  });

  it("records MCP routing and receipt delivery around the broker call", async () => {
    const { call, recordMcpLifecycle, execute } = setup();
    execute.mockImplementationOnce(async (_claims, input) => {
      const request = BrowserAutomationRequestSchema().parse(input);
      return {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        requestId: request.requestId,
        sequence: request.sequence,
        ok: false,
        error: { code: "TIMEOUT", message: "timed out", retryable: true, effect: "unknown" },
      };
    });

    await call("browser_inspect");

    expect(recordMcpLifecycle.mock.calls.map(([stage, providerId, , fields]) => [stage, providerId, fields])).toEqual([
      ["mcp-routing", "cursor", { outcome: "accepted" }],
      ["receipt-delivery", "cursor", { durationMs: 0, outcome: "failed", settlement: "unknown" }],
    ]);
  });

  it.each<BrowserAutomationPublicOperation>(["open", "inspect", "act", "tabs", "evaluate"])(
    "exposes a flat top-level schema for %s",
    (operation) => {
      const { toolkit } = setup();
      const tool = toolkit.bind(session)?.tools.find((candidate) => candidate.name === `browser_${operation}`);

      expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      for (const keyword of ["oneOf", "anyOf", "allOf"]) expect(tool?.inputSchema).not.toHaveProperty(keyword);
    },
  );
});
