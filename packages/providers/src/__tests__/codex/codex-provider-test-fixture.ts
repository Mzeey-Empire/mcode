import type { TurnRequest } from "@mcode/contracts/providers/interfaces";
import { ProviderRuntimeEventSchema, type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import * as NodeCrypto from "node:crypto";
import { CodexProvider as PackageCodexProvider } from "../../private/codex/codex-provider.js";
import type { CodexProviderPorts } from "../../factory-types.js";
import type {
  ProviderBrowserLeaseGrant,
  ProviderBrowserLeaseHandle,
  ProviderBrowserLeaseRequest,
  ProviderEventSinkPort,
  ProviderHostPorts,
  ProviderMcodeAttachment,
  ProviderMcodeAttachRequest,
} from "../../host-ports.js";

interface TestBrowserScope extends ProviderBrowserLeaseRequest {}

interface TestPendingLease {
  scope: TestBrowserScope;
}

/** Small in-memory credential registry used by provider tests without server DI. */
export class TestCredentialRegistry {
  private readonly credentialIds = new Set<string>();

  /** Returns the number of credentials retained by the fixture. */
  size(): number {
    return this.credentialIds.size;
  }

  /** Returns a truthy result for a currently retained credential. */
  touch(credentialId: string): object | null {
    return this.credentialIds.has(credentialId) ? {} : null;
  }

  add(credentialId: string): void {
    this.credentialIds.add(credentialId);
  }

  remove(credentialId: string): void {
    this.credentialIds.delete(credentialId);
  }

  /** Clears all credentials when the owning lease shuts down. */
  clear(): void {
    this.credentialIds.clear();
  }
}

/** Returns a process-environment authority for provider unit tests. */
export function stubEnvService(): { getEnv(): Record<string, string> } {
  return {
    getEnv: () => Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  };
}

/** Provider-neutral browser lease test double for Codex lifecycle coverage. */
export class BrowserAutomationSessionLease {
  readonly credentials = new TestCredentialRegistry();
  private readonly pending = new Map<string, TestPendingLease>();
  private readonly active = new Map<string, { credentialId: string; scope: TestBrowserScope }>();
  private configured = false;

  /** Marks the lease usable, as server composition does once it knows the worktree identity. */
  configure(_configuration: { worktreeIdentity: string }): void {
    this.configured = true;
  }

  /** Reports whether credentials can be issued. */
  isConfigured(): boolean {
    return this.configured;
  }

  /** Stages one browser scope. */
  stage(scope: TestBrowserScope): ProviderBrowserLeaseHandle {
    const leaseId = NodeCrypto.randomUUID();
    this.pending.set(leaseId, { scope });
    return { leaseId, expiresAt: Date.now() + 30_000 };
  }

  /** Issues a credential for either a staged handle or a complete scope. */
  issue(
    stageOrScope: ProviderBrowserLeaseHandle | TestBrowserScope,
  ): ProviderBrowserLeaseGrant | null {
    const stage = "leaseId" in stageOrScope ? stageOrScope : this.stage(stageOrScope);
    const pending = this.pending.get(stage.leaseId);
    this.pending.delete(stage.leaseId);
    if (!pending || !this.configured) return null;
    const credentialId = NodeCrypto.randomUUID();
    this.credentials.add(credentialId);
    this.active.set(stage.leaseId, { credentialId, scope: pending.scope });
    return {
      leaseId: stage.leaseId,
      credentialId,
      expiresAt: stage.expiresAt,
      allowedOperations: pending.scope.permissionCapability === "observe"
        ? ["inspect"]
        : ["inspect", "click", "type", "evaluate"],
    };
  }

  /** Releases one active or pending lease. */
  release(leaseId: string): { leaseId: string; released: boolean; credentialId?: string } {
    this.pending.delete(leaseId);
    const active = this.active.get(leaseId);
    if (!active) return { leaseId, released: false };
    this.active.delete(leaseId);
    this.credentials.remove(active.credentialId);
    return { leaseId, released: true, credentialId: active.credentialId };
  }

  /** Releases every lease belonging to one provider session. */
  releaseSession(providerId: string, sessionId: string): number {
    let released = 0;
    for (const [leaseId, active] of this.active) {
      if (active.scope.providerId === providerId && active.scope.mcodeSessionId === sessionId) {
        this.credentials.remove(active.credentialId);
        this.active.delete(leaseId);
        released += 1;
      }
    }
    for (const [leaseId, pending] of this.pending) {
      if (pending.scope.providerId === providerId && pending.scope.mcodeSessionId === sessionId) {
        this.pending.delete(leaseId);
        released += 1;
      }
    }
    return released;
  }

  /** Revokes credentials by opaque id; lifecycle tests only require a boolean. */
  revokeCredential(credentialId: string): boolean {
    for (const [leaseId, active] of this.active) {
      if (active.credentialId !== credentialId) continue;
      this.active.delete(leaseId);
      this.credentials.remove(active.credentialId);
      return true;
    }
    return true;
  }

  /** Returns bounded lease counts. */
  status(): { active: number; pending: number } {
    return { active: this.active.size, pending: this.pending.size };
  }

  /** Releases all credentials and pending scopes. */
  shutdown(): void {
    this.active.clear();
    this.pending.clear();
    this.credentials.clear();
  }
}

/** Builds the attachment the server hands a Codex session; tests override the toolkits they exercise. */
export function mcodeAttachment(
  toolkits: ProviderMcodeAttachment["toolkits"] = { browser: true, threadControl: true, visuals: true },
): ProviderMcodeAttachment {
  return { serverName: "mcode", url: "http://127.0.0.1:19400/mcp/mcode", token: "session-token-fixture", toolkits };
}

/** Builds the package-private Codex Provider with local test authorities. */
export class CodexProvider extends PackageCodexProvider {
  private readonly canonicalRequests = new Map<string, TurnRequest<"codex">>();

  override async sendTurn(request: TurnRequest<"codex">): Promise<void> {
    this.canonicalRequests.set(request.turnExecutionId, request);
    await super.sendTurn(request);
  }

  async flushCanonicalEvents(): Promise<void> {
    for (const request of this.canonicalRequests.values()) {
      await this.waitForCanonicalTurnEvents({
        threadId: request.threadId, turnId: request.turnId,
        executionId: request.turnExecutionId, deliveryAttempt: request.deliveryAttempt ?? 1,
      });
    }
  }

  private readonly canonicalObservers: Set<(event: ProviderRuntimeEvent) => void>;

  observeCanonicalEvents(observer: (event: ProviderRuntimeEvent) => void): this {
    this.canonicalObservers.add(observer);
    return this;
  }

  readonly settingsService!: { get(): unknown | Promise<unknown> };

  constructor(
    settings: { get(): unknown | Promise<unknown> },
    environment: { getEnv(): Record<string, string> },
    attachments: CodexProviderPorts["attachments"],
    catalog: CodexProviderPorts["catalog"],
    browser = new BrowserAutomationSessionLease(),
    mcode?: {
      attach?: (request: ProviderMcodeAttachRequest) => Promise<ProviderMcodeAttachment | null>;
      close?: (sessionId: string) => Promise<void>;
    },
    eventSink?: ProviderEventSinkPort,
  ) {
    const observers = new Set<(event: ProviderRuntimeEvent) => void>();
    const delegatedSettingsService = { get: () => settings.get() };
    const host: ProviderHostPorts = {
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      environment: { snapshot: () => environment.getEnv() },
      processes: { attach: () => undefined, terminateTree: async () => undefined },
      browser: {
        stage: (request) => browser.stage(request),
        releaseSession: (providerId, sessionId) => browser.releaseSession(providerId, sessionId),
        isConfigured: () => browser.isConfigured(),
        issue: (stage) => browser.issue(stage),
        refresh: () => { throw new Error("Unexpected browser credential refresh in Codex fixture"); },
        release: (leaseId) => browser.release(leaseId),
        revokeCredential: (credentialId) => browser.revokeCredential(credentialId),
      },
      mcode: {
        attach: (request) => mcode?.attach?.(request) ?? Promise.resolve(null),
        close: (sessionId) => mcode?.close?.(sessionId) ?? Promise.resolve(),
      },
      grants: { consume: () => false },
      events: {
        submit: async (batch) => {
          const receipt = eventSink ? await eventSink.submit(batch) : {
            commit: {
              outcome: "committed" as const, conversationRevision: 1, rosterRevision: 0,
              acceptedThrough: 1, durableThrough: 1, eventCount: batch.events.length,
            },
            delivery: { ingress: "queued" as const },
          };
          for (const draft of batch.events) {
            if (draft.payload.type !== "item.recorded" || draft.payload.item.payload.projection !== "providerRuntimeEvent") continue;
            const event = ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent);
            for (const observer of observers) observer(event);
          }
          return receipt;
        },
      },
    };
    const codexPorts: CodexProviderPorts = {
      settings: {
        get: async () => {
          const value = await delegatedSettingsService.get() as {
            provider?: { cli?: { codex?: string }; codex?: { fastMode?: boolean } };
          };
          return {
            cliPath: value.provider?.cli?.codex || "codex",
            fastMode: value.provider?.codex?.fastMode === true,
          };
        },
      },
      attachments,
      catalog,
    };
    super(host, codexPorts, 10 * 60 * 1_000);
    this.canonicalObservers = observers;
    this.settingsService = delegatedSettingsService;
  }
}

export function fixtureExecutionId(sessionId: string): string {
  const hash = NodeCrypto.createHash("sha256").update(sessionId).digest("hex");
  return hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-4" + hash.slice(13, 16)
    + "-8" + hash.slice(17, 20) + "-" + hash.slice(20, 32);
}
