import * as NodeCrypto from "node:crypto";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_OPERATION_METADATA,
  BROWSER_V2_CORE_OPERATIONS,
  BrowserAutomationRequestSchema,
  type BrowserAutomationPublicOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationResult,
} from "@mcode/contracts";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  BrowserAutomationBroker,
  BrowserAutomationCredentialClaims,
  BrowserAutomationSessionLease,
} from "../../browser-automation/index.js";
import {
  defineToolkit,
  type McodeTool,
  type McodeToolCall,
  type McodeToolkit,
} from "../mcode-toolkit.js";
import type { McodeSession } from "../mcode-session-authority.js";
import { browserInputSchema, browserToolDescription } from "./browser-tool-schemas.js";

const OPERATIONS = [...BROWSER_V2_CORE_OPERATIONS, "evaluate" as const];
const REQUEST_DEADLINE_MS = 60_000;

/** Dependencies for the Browser toolkit. */
export interface BrowserToolkitOptions {
  lease: Pick<BrowserAutomationSessionLease, "claimsFor">;
  broker: Pick<
    BrowserAutomationBroker,
    "execute" | "availableOperations" | "cancelFromProvider" | "recordMcpLifecycle"
  >;
  now?: () => number;
  maxSequenceEntries?: number;
  sequenceTtlMs?: number;
}

interface BrowserGrant {
  claims: BrowserAutomationCredentialClaims;
  listed: ReadonlySet<BrowserAutomationPublicOperation>;
}

interface ActiveCall {
  claims: BrowserAutomationCredentialClaims;
  requestId: string;
  sequence: number;
}

type BrowserScreenshot = NonNullable<Extract<BrowserAutomationResult, { operation: "inspect" }>["screenshot"]>;

function forbidden(message: string): McpError {
  return new McpError(-32003, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpContent(result: BrowserAutomationResponse): CallToolResult["content"] {
  if (!result.ok) return [{ type: "text", text: JSON.stringify(result.error) }];
  const screenshot = screenshotOf(result.result);
  if (!screenshot) return [{ type: "text", text: JSON.stringify(result.result) }];
  const { dataBase64, ...metadata } = screenshot;
  return [
    { type: "text", text: JSON.stringify({ ...result.result, screenshot: metadata }) },
    { type: "image", data: dataBase64, mimeType: screenshot.mediaType },
  ];
}

function screenshotOf(result: BrowserAutomationResult): BrowserScreenshot | undefined {
  return result.operation === "inspect" ? result.screenshot : undefined;
}

/**
 * Serves the visible-Browser tools on the `mcode` MCP server and owns the
 * per-credential request sequences and in-flight calls that bound them.
 */
export class BrowserToolkit implements McodeToolkit {
  readonly name = "browser";
  private readonly lease: BrowserToolkitOptions["lease"];
  private readonly broker: BrowserToolkitOptions["broker"];
  private readonly now: () => number;
  private readonly maxSequenceEntries: number;
  private readonly sequenceTtlMs: number;
  private readonly sequences = new Map<string, { sequence: number; lastUsedAt: number }>();
  private readonly activeCalls = new Map<string, ActiveCall>();
  private readonly toolkit: McodeToolkit;

  constructor(options: BrowserToolkitOptions) {
    this.lease = options.lease;
    this.broker = options.broker;
    this.now = options.now ?? Date.now;
    this.maxSequenceEntries = options.maxSequenceEntries ?? 256;
    this.sequenceTtlMs = options.sequenceTtlMs ?? 30 * 60_000;
    if (!Number.isInteger(this.maxSequenceEntries) || this.maxSequenceEntries < 1 || this.maxSequenceEntries > 4_096) {
      throw new Error("Browser MCP sequence capacity is invalid");
    }
    if (!Number.isInteger(this.sequenceTtlMs) || this.sequenceTtlMs < 1_000 || this.sequenceTtlMs > 24 * 60 * 60_000) {
      throw new Error("Browser MCP sequence TTL is invalid");
    }
    this.toolkit = defineToolkit<BrowserGrant>({
      name: this.name,
      grant: (session) => this.grant(session),
      tools: OPERATIONS.map((operation) => this.tool(operation)),
    });
  }

  bind(session: McodeSession): ReturnType<McodeToolkit["bind"]> {
    return this.toolkit.bind(session);
  }

  /** Releases per-credential sequence state when a credential is revoked. */
  releaseCredential(credentialId: string): boolean {
    let removed = this.sequences.delete(credentialId);
    for (const [key, call] of this.activeCalls) {
      if (call.claims.credentialId !== credentialId) continue;
      this.activeCalls.delete(key);
      removed = true;
    }
    return removed;
  }

  /** Prunes expired per-credential sequence state at an explicit lifecycle checkpoint. */
  sweep(): void {
    const now = this.now();
    for (const [credentialId, state] of this.sequences) {
      if (now - state.lastUsedAt >= this.sequenceTtlMs) this.sequences.delete(credentialId);
    }
  }

  private grant(session: McodeSession): BrowserGrant | null {
    const claims = this.lease.claimsFor(session.providerId, session.sessionId);
    if (!claims) return null;
    return { claims, listed: new Set(this.discoverableOperations(claims)) };
  }

  /** Core tools stay discoverable during transient unavailability; negotiated extras follow. */
  private discoverableOperations(
    claims: BrowserAutomationCredentialClaims,
  ): readonly BrowserAutomationPublicOperation[] {
    const core = BROWSER_V2_CORE_OPERATIONS.filter((operation) => claims.allowedOperations.includes(operation));
    const negotiated = this.broker.availableOperations(claims);
    return [...core, ...negotiated.filter((operation) => !core.some((coreOperation) => coreOperation === operation))];
  }

  private tool(operation: BrowserAutomationPublicOperation): McodeTool<BrowserGrant> {
    const metadata = BROWSER_AUTOMATION_OPERATION_METADATA[operation];
    return {
      name: metadata.mcpName,
      description: browserToolDescription(operation),
      inputSchema: browserInputSchema(operation),
      annotations: {
        readOnlyHint: metadata.annotations.readOnly,
        destructiveHint: metadata.annotations.destructive,
        idempotentHint: metadata.annotations.idempotent,
        openWorldHint: metadata.annotations.openWorld,
      },
      listed: (grant) => grant.listed.has(operation),
      call: (args, grant, call) => this.callOperation(operation, args, grant.claims, call),
    };
  }

  /** Calls are gated by the credential's operations, not by live negotiation. */
  private async callOperation(
    operation: BrowserAutomationPublicOperation,
    args: unknown,
    claims: BrowserAutomationCredentialClaims,
    call: McodeToolCall,
  ): Promise<CallToolResult> {
    if (!claims.allowedOperations.includes(operation)) throw forbidden("Browser operation is forbidden");
    if (operation === "evaluate" && claims.permissionCapability !== "privileged") {
      throw forbidden("Browser evaluation is forbidden");
    }
    const parsed = this.createBrowserRequest(claims, operation, isRecord(args) ? args : {});
    if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, "Invalid browser tool arguments");
    const result = await this.executeToolCall(claims, call, parsed.data);
    const toolResult: CallToolResult = { content: mcpContent(result), isError: !result.ok };
    if (Buffer.byteLength(JSON.stringify(toolResult)) > BROWSER_AUTOMATION_MAX_RESULT_BYTES) {
      throw new McpError(-32002, "Browser result exceeds the response limit");
    }
    return toolResult;
  }

  private createBrowserRequest(
    claims: BrowserAutomationCredentialClaims,
    operation: BrowserAutomationPublicOperation,
    args: Record<string, unknown>,
  ): ReturnType<ReturnType<typeof BrowserAutomationRequestSchema>["safeParse"]> {
    const { expectedControlEpoch, ...values } = args;
    return BrowserAutomationRequestSchema().safeParse({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      workspaceId: claims.workspaceId,
      threadId: claims.threadId,
      providerSessionId: claims.providerSessionId,
      providerInstanceId: claims.mcodeSessionId,
      requestId: NodeCrypto.randomUUID(),
      sequence: this.nextSequence(claims.credentialId),
      deadline: this.now() + REQUEST_DEADLINE_MS,
      expectedControlEpoch: typeof expectedControlEpoch === "number" ? expectedControlEpoch : 0,
      operation,
      args: values,
    });
  }

  private nextSequence(credentialId: string): number {
    this.sweep();
    const sequence = (this.sequences.get(credentialId)?.sequence ?? 0) + 1;
    if (!this.sequences.has(credentialId)) {
      while (this.sequences.size >= this.maxSequenceEntries) this.evictOldestSequence();
    }
    this.sequences.set(credentialId, { sequence, lastUsedAt: this.now() });
    return sequence;
  }

  private evictOldestSequence(): void {
    let oldest: [string, { lastUsedAt: number }] | undefined;
    for (const entry of this.sequences) {
      if (!oldest || entry[1].lastUsedAt < oldest[1].lastUsedAt) oldest = entry;
    }
    if (oldest) this.sequences.delete(oldest[0]);
  }

  private async executeToolCall(
    claims: BrowserAutomationCredentialClaims,
    call: McodeToolCall,
    request: BrowserAutomationRequest,
  ): Promise<BrowserAutomationResponse> {
    const startedAt = this.now();
    this.broker.recordMcpLifecycle("mcp-routing", claims.providerId, request, { outcome: "accepted" });
    const activeKey = JSON.stringify([claims.credentialId, call.toolCallId]);
    this.assertAdmitted(activeKey);
    const active: ActiveCall = { claims, requestId: request.requestId, sequence: request.sequence };
    this.activeCalls.set(activeKey, active);
    const result = await this.executeActiveCall(activeKey, active, request, call.signal);
    this.broker.recordMcpLifecycle("receipt-delivery", claims.providerId, request, {
      durationMs: Math.max(0, this.now() - startedAt),
      outcome: result.ok ? "completed" : "failed",
      settlement: result.ok || result.error.effect !== "unknown" ? "complete" : "unknown",
    });
    return result;
  }

  private assertAdmitted(activeKey: string): void {
    if (this.activeCalls.has(activeKey)) {
      throw new McpError(ErrorCode.InvalidRequest, "Browser tool request id is already active");
    }
    if (this.activeCalls.size >= this.maxSequenceEntries) {
      throw new McpError(-32004, "Browser tool call capacity is exhausted");
    }
  }

  private async executeActiveCall(
    activeKey: string,
    active: ActiveCall,
    request: BrowserAutomationRequest,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const cancel = (): void => this.cancelActiveCall(activeKey);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const pending = this.broker.execute(active.claims, request);
      if (signal.aborted) cancel();
      return await pending;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (this.activeCalls.get(activeKey) === active) this.activeCalls.delete(activeKey);
    }
  }

  private cancelActiveCall(activeKey: string): void {
    const active = this.activeCalls.get(activeKey);
    if (!active) return;
    this.activeCalls.delete(activeKey);
    this.broker.cancelFromProvider(active.claims, active.requestId, active.sequence);
  }
}
