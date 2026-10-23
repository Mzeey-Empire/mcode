import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_OPERATIONS,
  BrowserAutomationRequestSchema,
  type BrowserAutomationActStep,
  type BrowserAutomationError,
  type BrowserAutomationPublicOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationResult,
} from "@mcode/contracts";
import {
  createBrowserThreadControl,
  reduceBrowserControl,
  type BrowserThreadControl,
} from "@mcode/shared/browser-control";
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

type Execute = BrowserToolkitOptions["broker"]["execute"];

function textOf(result: CallToolResult): string {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
}

function firstRef(result: CallToolResult): string {
  const parsed = JSON.parse(textOf(result)) as { snapshot?: { elements: { ref: string }[] } };
  const ref = parsed.snapshot?.elements[0]?.ref;
  if (!ref) throw new Error("inspect returned no element reference");
  return ref;
}

function snapshotOf(semanticIds: readonly string[]): NonNullable<Extract<BrowserAutomationResult, { operation: "inspect" }>["snapshot"]> {
  const none = { truncated: false } as const;
  return {
    url: "https://example.com/",
    title: "Fixture",
    loading: false,
    visibleText: "Fixture form",
    visibleTextTruncation: none,
    elements: semanticIds.map((semanticId) => ({
      semanticId,
      role: semanticId === "e-name" ? "textbox" : "button",
      accessibleName: semanticId === "e-name" ? "Name" : "Submit",
      disabled: false,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    })),
    elementsTruncation: none,
    accessibility: [],
    accessibilityTruncation: none,
    console: [],
    consoleTruncation: none,
    network: [],
    networkTruncation: none,
    actions: [],
    actionsTruncation: none,
  };
}

/**
 * Stands in for the broker and visible host: single-use observations, the
 * shared control reducer, and idempotent replay keyed like the real broker.
 */
function fakeBrowser() {
  let control: BrowserThreadControl = createBrowserThreadControl();
  let counter = 0;
  const live = new Set<string>();
  const replay = new Map<string, BrowserAutomationResponse>();
  const effects: BrowserAutomationActStep[] = [];
  const actResults: BrowserAutomationResult[] = [];
  const epoch = () => control.epochByTab.get("tab-1") ?? 0;
  const observe = (prefix = "obs"): string => {
    const ref = `${prefix}-${(counter += 1)}`;
    live.add(ref);
    return ref;
  };
  const refuse = (request: BrowserAutomationRequest, error: BrowserAutomationError): BrowserAutomationResponse => ({
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: request.requestId,
    sequence: request.sequence,
    ok: false,
    error,
  });
  const act = (request: Extract<BrowserAutomationRequest, { operation: "act" }>): BrowserAutomationResponse => {
    const decision = reduceBrowserControl(control, { type: "agent-effect", tabId: "tab-1", expectedEpoch: request.expectedControlEpoch });
    if (!decision.admitted) {
      const recovery = decision.code === "HUMAN_INTERRUPTED" ? "yield_to_user" : "inspect";
      return refuse(request, { code: decision.code, message: "refused", retryable: true, recovery });
    }
    control = decision.next;
    if (!live.delete(request.args.observationRef)) {
      return refuse(request, { code: "STALE_TARGET_GENERATION", message: "stale", retryable: true, recovery: "inspect" });
    }
    effects.push(...request.args.steps);
    const nextObservationRef = observe();
    const result: BrowserAutomationResult = {
      operation: "act",
      outcome: "completed",
      stoppingPosition: request.args.steps.length,
      effect: "complete",
      recovery: "inspect",
      receipts: request.args.steps.map((step, index) => ({ index, operation: step.operation, status: "applied" })),
      finalObservation: { observationRef: nextObservationRef, hostRevision: 1, documentRevision: 1, controlRevision: epoch(), capabilityRevision: 1, observationRevision: counter },
      nextObservationRef,
    };
    actResults.push(result);
    return responseFor(request, result);
  };
  const respond = (request: BrowserAutomationRequest): BrowserAutomationResponse => {
    switch (request.operation) {
      case "inspect":
        return responseFor(request, { operation: "inspect", controlEpoch: epoch(), tabs: [], observationRef: observe(), snapshot: snapshotOf(["e-name", "e-submit"]) });
      case "open":
        live.add("obs-open");
        return responseFor(request, { operation: "open", url: "https://example.com/", title: "Fixture", controlEpoch: epoch(), observationRef: "obs-open" });
      case "tabs":
        return responseFor(request, { operation: "tabs", action: request.args.action, tabs: [], observationRef: observe() });
      case "act":
        return act(request);
      default:
        throw new Error(`unexpected ${request.operation}`);
    }
  };
  const execute: Execute = async (_claims, input) => {
    const request = BrowserAutomationRequestSchema().parse(input);
    const key = "idempotencyKey" in request.args ? request.args.idempotencyKey : undefined;
    const cached = key === undefined ? undefined : replay.get(key);
    if (cached) return { ...cached, requestId: request.requestId, sequence: request.sequence };
    const response = respond(request);
    if (key !== undefined) replay.set(key, response);
    return response;
  };
  return {
    execute,
    effects,
    actResults,
    control(event: Parameters<typeof reduceBrowserControl>[1]) {
      control = reduceBrowserControl(control, event).next;
    },
  };
}

function setup(options: {
  claims?: BrowserAutomationCredentialClaims | null;
  maxSequenceEntries?: number;
  execute?: Execute;
} = {}) {
  const claims = options.claims === undefined ? claimsWith() : options.claims;
  const claimsFor = vi.fn<BrowserToolkitOptions["lease"]["claimsFor"]>(() => claims);
  const execute = vi.fn<Execute>(options.execute ?? (async (_claims, input) => responseFor(input, inspectResult)));
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
    expect(named("browser_evaluate")?.inputSchema.required).toEqual(["expression"]);
    expect(named("browser_act")?.inputSchema.required).toEqual(["action"]);
    expect(tools.map((tool) => tool.name).join(" ")).not.toMatch(/browser_(status|navigate|snapshot|click|type)/);
  });

  it("never asks the model for observation, control, idempotency, deadline, or batch fields", () => {
    const tools = setup().toolkit.bind(session)?.tools ?? [];

    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      const fields = [...Object.keys(tool.inputSchema.properties ?? {}), ...(tool.inputSchema.required ?? [])];
      for (const internal of ["observationRef", "expectedControlEpoch", "idempotencyKey", "deadlineMs", "steps"]) {
        expect(fields, `${tool.name} exposes ${internal}`).not.toContain(internal);
      }
    }
  });

  it("refuses an operation the credential does not allow and evaluation without privilege", async () => {
    const observe = setup({ claims: claimsWith({ permissionCapability: "observe", allowedOperations: ["inspect"] }) });
    await expect(observe.call("browser_open", { url: "https://example.com" }))
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

  it("binds the request to the credential scope", async () => {
    const { call, requestAt, execute } = setup();

    await call("browser_inspect", { includeDiagnostics: true });

    expect(execute.mock.calls[0]?.[0]).toMatchObject({ credentialId: "credential-a" });
    expect(requestAt(0)).toMatchObject({
      workspaceId: "workspace-a",
      threadId: "thread-a",
      providerSessionId: "provider-session",
      providerInstanceId: "mcode-session",
      operation: "inspect",
      expectedControlEpoch: 0,
      sequence: 1,
      deadline: 61_000,
      args: { includeDiagnostics: true },
    });
  });

  it("rejects caller-supplied scope, internal fields, and invalid argument shapes before the broker", async () => {
    const page = fakeBrowser();
    const { call, execute } = setup({ execute: page.execute });
    await call("browser_inspect", {}, { toolCallId: "inspect" });
    execute.mockClear();

    await expect(call("browser_inspect", { threadId: "thread-b" }))
      .rejects.toMatchObject({ code: -32602, message: expect.stringContaining("Invalid browser tool arguments") });
    await expect(call("browser_act", { action: "click", ref: "s1e1", expectedControlEpoch: 3 }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(call("browser_act", { action: "click", ref: "s1e1", observationRef: "obs-1" }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(call("browser_act", { action: "click" })).rejects.toMatchObject({ code: -32602 });
    await expect(call("browser_act", { action: "fly" })).rejects.toMatchObject({ code: -32602 });
    await expect(call("browser_act", { action: "navigate", url: "https://example.com", ref: "s1e1" }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(call("browser_tabs", { action: "select" })).rejects.toMatchObject({ code: -32602 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("opens with a server-generated idempotency key and routes tabs with the observation it returned", async () => {
    const page = fakeBrowser();
    const { call, requestAt } = setup({ execute: page.execute });

    const opened = await call("browser_open", { url: "https://example.com" }, { toolCallId: "open" });
    await call("browser_tabs", { action: "select", tabId: "tab-2" }, { toolCallId: "tabs" });

    expect(JSON.parse(textOf(opened))).toEqual({ operation: "open", url: "https://example.com/", title: "Fixture" });
    expect(requestAt(0)).toMatchObject({ operation: "open", args: { url: "https://example.com", idempotencyKey: expect.any(String) } });
    expect(requestAt(1)).toMatchObject({
      operation: "tabs",
      args: { action: "select", tabId: "tab-2", idempotencyKey: expect.any(String), observationRef: "obs-open" },
    });
  });

  it("completes a multi-step flow using only snapshot references", async () => {
    const page = fakeBrowser();
    const { call, requestAt } = setup({ execute: page.execute });

    const inspected = await call("browser_inspect", {}, { toolCallId: "1" });
    const snapshot = JSON.parse(textOf(inspected)) as { snapshot: { elements: { ref: string; accessibleName: string }[] } };
    const refFor = (name: string) => snapshot.snapshot.elements.find((element) => element.accessibleName === name)?.ref;
    const typed = await call("browser_act", { action: "type", ref: refFor("Name"), text: "Ada" }, { toolCallId: "2" });
    const clicked = await call("browser_act", { action: "click", ref: refFor("Submit") }, { toolCallId: "3" });

    expect(textOf(inspected)).not.toMatch(/semanticId|observationRef|controlEpoch/);
    expect([typed.isError, clicked.isError]).toEqual([false, false]);
    expect(JSON.parse(textOf(clicked))).toEqual({
      operation: "act",
      outcome: "completed",
      stoppingPosition: 1,
      effect: "complete",
      recovery: "inspect",
      receipts: [{ index: 0, operation: "click", status: "applied" }],
    });
    expect(page.effects).toEqual([
      { operation: "type", target: { semanticId: "e-name" }, text: "Ada", clear: false, submit: false },
      { operation: "click", target: { semanticId: "e-submit" }, button: "left", clickCount: 1 },
    ]);
    expect(requestAt(2).args).toMatchObject({ observationRef: (page.actResults[0] as { nextObservationRef: string }).nextObservationRef });
    expect(requestAt(2).args).toMatchObject({ deadlineMs: 60_000, idempotencyKey: expect.any(String) });
  });

  it("refuses a reference from an older snapshot and tells the agent to snapshot again", async () => {
    const page = fakeBrowser();
    const { call, execute } = setup({ execute: page.execute });

    const beforeInspect = await call("browser_act", { action: "click", ref: "s1e2" }, { toolCallId: "0" });
    await call("browser_inspect", {}, { toolCallId: "1" });
    const older = firstRef(await call("browser_inspect", {}, { toolCallId: "2" }));
    const staleRef = older.replace(/^s(\d+)/, (_match, id: string) => `s${Number(id) - 1}`);
    const stale = await call("browser_act", { action: "click", ref: staleRef }, { toolCallId: "3" });
    const unknown = await call("browser_act", { action: "click", ref: older.replace(/e\d+$/, "e99") }, { toolCallId: "4" });

    for (const refused of [beforeInspect, stale, unknown]) {
      expect(refused.isError).toBe(true);
      expect(JSON.parse(textOf(refused))).toMatchObject({
        code: "STALE_TARGET_GENERATION",
        retryable: true,
        recovery: "inspect",
        message: expect.stringContaining("browser_inspect"),
      });
    }
    expect(execute.mock.calls.map(([, request]) => (request as BrowserAutomationRequest).operation)).toEqual(["inspect", "inspect"]);
    expect(page.effects).toEqual([]);
  });

  it("drops references once navigation replaces the document", async () => {
    const page = fakeBrowser();
    const { call } = setup({ execute: page.execute });

    const ref = firstRef(await call("browser_inspect", {}, { toolCallId: "1" }));
    await call("browser_act", { action: "navigate", url: "https://example.com/next" }, { toolCallId: "2" });
    const refused = await call("browser_act", { action: "click", ref }, { toolCallId: "3" });

    expect(JSON.parse(textOf(refused))).toMatchObject({ code: "STALE_TARGET_GENERATION", recovery: "inspect" });
    expect(page.effects.map((step) => step.operation)).toEqual(["navigate"]);
  });

  it("refuses an action while the user holds the tab and allows the next one after Hand back", async () => {
    const page = fakeBrowser();
    const { call, requestAt } = setup({ execute: page.execute });

    const ref = firstRef(await call("browser_inspect", {}, { toolCallId: "1" }));
    page.control({ type: "take-control", tabId: "tab-1" });
    const held = await call("browser_act", { action: "click", ref }, { toolCallId: "2" });
    page.control({ type: "hand-back" });
    const staleAfterHold = await call("browser_act", { action: "click", ref }, { toolCallId: "3" });
    const fresh = firstRef(await call("browser_inspect", {}, { toolCallId: "4" }));
    const resumed = await call("browser_act", { action: "click", ref: fresh }, { toolCallId: "5" });

    expect(JSON.parse(textOf(held))).toMatchObject({ code: "HUMAN_INTERRUPTED", recovery: "yield_to_user" });
    expect(JSON.parse(textOf(staleAfterHold))).toMatchObject({ code: "STALE_TARGET_GENERATION", recovery: "inspect" });
    expect(resumed.isError).toBe(false);
    expect(requestAt(3).expectedControlEpoch).toBe(2);
    expect(page.effects).toHaveLength(1);
  });

  it("applies a redelivered action once and a new call with the same arguments again", async () => {
    const page = fakeBrowser();
    const { call, requestAt } = setup({ execute: page.execute });
    const ref = firstRef(await call("browser_inspect", {}, { toolCallId: "1" }));

    const first = await call("browser_act", { action: "click", ref }, { toolCallId: "7" });
    const redelivered = await call("browser_act", { action: "click", ref }, { toolCallId: "7" });
    expect(textOf(redelivered)).toBe(textOf(first));
    expect(page.effects).toHaveLength(1);
    expect(requestAt(2).args).toEqual(requestAt(1).args);

    const again = await call("browser_act", { action: "click", ref }, { toolCallId: "8" });
    expect(again.isError).toBe(false);
    expect(page.effects).toHaveLength(2);
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
    expect(plain.content).toEqual([{ type: "text", text: JSON.stringify({ operation: "inspect", tabs: [] }) }]);
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
