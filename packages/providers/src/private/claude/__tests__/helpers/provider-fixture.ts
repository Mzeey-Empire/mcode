import { ClaudeProvider as RuntimeClaudeProvider } from "../../claude-provider.js";
import type { ProviderHostPorts, ProviderEventSinkPort, ProviderBrowserPort, ProviderBrowserLeaseRequest, ProviderBrowserLeaseHandle, ProviderBrowserLeaseGrant } from "../../../../host-ports.js";
import { mockProviderHostRuntime } from "./mock-sdk-query.js";

/** A deterministic host authority for the extracted adapter tests. */
export function fixtureHost(overrides: Partial<ProviderHostPorts> = {}): ProviderHostPorts {
  return {
    runtime: mockProviderHostRuntime,
    environment: { snapshot: () => ({}) },
    processes: { attach: () => undefined, terminateTree: async () => undefined },
    browser: new BrowserAutomationSessionLease(),
    mcode: { attach: async () => null, close: async () => undefined },
    grants: { consume: () => false },
    turns: { open: async () => ({ kind: "declined", reason: "unavailable" }), settleBackgroundTool: async () => {} },
    events: { submit: async (batch) => ({ commit: { outcome: "committed", conversationRevision: 0, rosterRevision: 0, acceptedThrough: 0, durableThrough: 0, eventCount: batch.events.length }, delivery: { ingress: "queued" } }) },
    ...overrides,
  };
}

/** Legacy test construction translated into required production host ports. */
export class ClaudeProvider extends RuntimeClaudeProvider {
  constructor(
    environment: { getEnv(): Record<string, string> },
    _processes: unknown,
    grants?: { tryConsume(request: { threadId: string; toolName: string; path: string }): boolean },
    browser?: ProviderHostPorts["browser"],
    _threadControl?: unknown,
    suppliedHost?: Pick<ProviderHostPorts, "runtime" | "events"> & Partial<Pick<ProviderHostPorts, "mcode">>,
  ) {
    let emit: ((event: unknown) => void) | undefined;
    const host = fixtureHost({
      environment: { snapshot: () => environment.getEnv() },
      ...(browser && { browser }),
      ...(grants && { grants: { consume: (request) => grants.tryConsume(request) } }),
      ...suppliedHost,
    });
    const originalSink: ProviderEventSinkPort = host.events;
    host.events = { submit: async (batch) => {
      const receipt = await originalSink.submit(batch);
      for (const draft of batch.events) {
        if (draft.payload.type !== "item.recorded") continue;
        const payload = draft.payload.item.payload;
        if (!suppliedHost && payload.projection === "providerRuntimeEvent") emit?.(payload.runtimeEvent);
      }
      return receipt;
    } };
    super(host, { cliPath: process.execPath, idleSessionTtlMs: 600_000 }, { createForker: () => ({ fork: async () => { throw new Error("Test handoff policy is not configured"); } }) });
    emit = (event) => { this.emit("event", event); };
  }
}

/** Environment fixture retained for the existing queue and stream assertions. */
export function stubEnvService() { return { getEnv: () => ({}) }; }
/** Process fixture retained without importing the server's containment service. */
export function stubJobObject() { return { isWindowsJob: false, assign: () => false }; }

/** Test grant authority that consumes an exact, single-use scope. */
export class ScopedPreGrantService {
  private readonly grants = new Set<string>();
  constructor(_runtime?: unknown) {}
  issue(request: { threadId: string; toolName: string; path: string }): void { this.grants.add(JSON.stringify(request)); }
  tryConsume(request: { threadId: string; toolName: string; path: string }): boolean { return this.grants.delete(JSON.stringify(request)); }
  hasActiveGrant(threadId: string): boolean { return [...this.grants].some((grant) => JSON.parse(grant).threadId === threadId); }
}

export type BrowserAutomationSessionLeaseScope = ProviderBrowserLeaseRequest;

/** Test credential authority retained by browser lease tests. */
export class BrowserAutomationCredentialRegistry {
  private readonly grants = new Map<string, ProviderBrowserLeaseGrant>();
  register(grant: ProviderBrowserLeaseGrant): void { this.grants.set(grant.credentialId, grant); }
  revoke(grant: ProviderBrowserLeaseGrant): void { this.grants.delete(grant.credentialId); }
  touch(credentialId: string): ProviderBrowserLeaseGrant | null { return this.grants.get(credentialId) ?? null; }
  size(): number { return this.grants.size; }
}

/** Deterministic browser authority, exercising provider use of the real port contract. */
export class BrowserAutomationSessionLease implements ProviderBrowserPort {
  private configured = false;
  private readonly pending = new Map<string, ProviderBrowserLeaseRequest>();
  private readonly active = new Map<string, { scope: ProviderBrowserLeaseRequest; grant: ProviderBrowserLeaseGrant }>();
  constructor(readonly credentials = new BrowserAutomationCredentialRegistry()) {}
  configure(_options: { worktreeIdentity: string }): void { this.configured = true; }
  isConfigured(): boolean { return this.configured; }
  stage(request: ProviderBrowserLeaseRequest): ProviderBrowserLeaseHandle {
    const leaseId = crypto.randomUUID();
    this.pending.set(leaseId, request);
    return { leaseId, expiresAt: Date.now() + 60_000 };
  }
  issue(stage: ProviderBrowserLeaseHandle | ProviderBrowserLeaseRequest): ProviderBrowserLeaseGrant | null {
    const handle = "leaseId" in stage ? stage : this.stage(stage);
    const scope = this.pending.get(handle.leaseId);
    if (!scope || !this.configured) return null;
    this.pending.delete(handle.leaseId);
    const grant = { leaseId: handle.leaseId, expiresAt: Date.now() + 60_000, credentialId: crypto.randomUUID(), allowedOperations: [] };
    this.active.set(handle.leaseId, { scope, grant });
    this.credentials.register(grant);
    return grant;
  }
  refresh(leaseId: string): ReturnType<ProviderHostPorts["browser"]["refresh"]> {
    const previous = this.active.get(leaseId);
    if (!previous) return { ok: false, leaseId, reason: "not-found" };
    this.release(leaseId);
    const grant = this.issue(previous.scope);
    return grant ? { ok: true, grant } : { ok: false, leaseId, reason: "unconfigured" };
  }
  release(leaseId: string): ReturnType<ProviderHostPorts["browser"]["release"]> {
    const active = this.active.get(leaseId);
    if (active) this.credentials.revoke(active.grant);
    const released = this.pending.delete(leaseId) || this.active.delete(leaseId);
    return { leaseId, released };
  }
  releaseSession(providerId: string, sessionId: string): number {
    let count = 0;
    for (const [leaseId, entry] of this.active) if (entry.scope.providerId === providerId && entry.scope.mcodeSessionId === sessionId) { this.release(leaseId); count++; }
    return count;
  }
  revokeCredential(credentialId: string): boolean {
    const entry = [...this.active.values()].find((value) => value.grant.credentialId === credentialId);
    return entry ? this.release(entry.grant.leaseId).released : false;
  }
  status(): { active: number; pending: number } { return { active: this.active.size, pending: this.pending.size }; }
  shutdown(): void { for (const leaseId of this.active.keys()) this.release(leaseId); this.pending.clear(); }
}
