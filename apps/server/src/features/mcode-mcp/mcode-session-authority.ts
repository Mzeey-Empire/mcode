import * as NodeCrypto from "node:crypto";
import type { ProviderMcodeAttachRequest } from "@mcode/providers";
import type { InternalThreadControlAuthority } from "@mcode/thread-orchestration";

/** Mutable server-owned lease for one provider turn. */
interface ActiveLease {
  sourceThreadId: string;
  sourceTurnId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
  active: boolean;
  /** Whether the current user request explicitly authorized Mcode thread control. */
  eligible: boolean;
  controller: AbortController;
}

interface SessionEntry {
  credential: string;
  digest: Buffer;
  /** Set by `attach`; a session activated before attach resolves to nothing. */
  session?: McodeSession;
  active?: ActiveLease;
}

/** Identity and listing flags that one session token resolves to. */
export interface McodeSession {
  readonly providerId: string;
  readonly sessionId: string;
  readonly threadId: string;
  /** Attach-time listing flag; it never depends on the turn lease. */
  readonly threadControl: boolean;
}

/** Provider turn fields used to activate a session's thread-control authority. */
export interface ActivateMcodeSessionLease {
  sessionId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
  /** Explicit per-turn eligibility derived from the original user request. */
  eligible?: boolean;
}

/** Opaque credential and stable session binding supplied to a provider transport. */
export interface McodeSessionCredential {
  credential: string;
  sessionId: string;
}

/** Refuses a thread-control call that has no active, eligible turn lease. */
export class McodeThreadControlDeniedError extends Error {
  constructor() {
    super("Internal thread-control MCP request denied");
  }
}

/** Compares two bearer values without exposing equal-length match timing. */
export function constantTimeCredentialEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function newCredential(): string {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

function digestOf(credential: string): Buffer {
  return NodeCrypto.createHash("sha256").update(credential).digest();
}

function newEntry(): SessionEntry {
  const credential = newCredential();
  return { credential, digest: digestOf(credential) };
}

/**
 * Owns one opaque bearer credential per provider session and the revocable turn
 * lease that backs thread control. Identity always comes from the credential's
 * session, never from tool arguments.
 */
export class McodeSessionAuthority {
  private readonly entries = new Map<string, SessionEntry>();

  /** Binds a session to its provider and thread; repeat calls return the same token. */
  attach(input: ProviderMcodeAttachRequest): { token: string } {
    const entry = this.entries.get(input.sessionId) ?? newEntry();
    entry.session = {
      providerId: input.providerId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      threadControl: input.threadControl,
    };
    this.entries.set(input.sessionId, entry);
    return { token: entry.credential };
  }

  /** Resolves an attached session by bearer token, or null when unknown, rotated, or closed. */
  resolve(token: string): McodeSession | null {
    return this.findByCredential(token)?.session ?? null;
  }

  /** Activates a turn lease without rotating the session credential. */
  activate(input: ActivateMcodeSessionLease): McodeSessionCredential {
    const entry = this.entries.get(input.sessionId) ?? newEntry();
    entry.active?.controller.abort();
    entry.active = {
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      sourceProviderId: input.sourceProviderId,
      permissionMode: input.permissionMode,
      eligible: input.eligible ?? true,
      active: true,
      controller: new AbortController(),
    };
    this.entries.set(input.sessionId, entry);
    return { credential: entry.credential, sessionId: input.sessionId };
  }

  /** Revokes the active turn lease while retaining the credential for pooled reuse. */
  revoke(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry?.active) {
      entry.active.active = false;
      entry.active.controller.abort();
    }
  }

  /** Removes a closed session and its credential permanently. */
  close(sessionId: string): void {
    this.entries.get(sessionId)?.active?.controller.abort();
    this.entries.delete(sessionId);
  }

  /** Invalidates a retired provider's credential while preserving an admitted turn's authority. */
  retire(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry?.active?.active) {
      this.close(sessionId);
      return;
    }
    entry.credential = newCredential();
    entry.digest = digestOf(entry.credential);
  }

  /**
   * Builds the thread-control authority from the session's turn lease.
   * @throws McodeThreadControlDeniedError when the lease is missing, revoked, or ineligible.
   */
  authorizeThreadControl(session: McodeSession, sourceToolCallId: string): InternalThreadControlAuthority {
    const authority = authorizeEntry(this.entries.get(session.sessionId), sourceToolCallId);
    if (!authority) throw new McodeThreadControlDeniedError();
    return authority;
  }

  /** Returns the revocation signal for a session while its turn lease is active. */
  signal(sessionId: string): AbortSignal | undefined {
    return activeSignal(this.entries.get(sessionId));
  }

  /** Returns the session credential only while a turn lease is active. */
  credential(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId);
    return entry?.active?.active ? entry.credential : undefined;
  }

  /** Resolves the active lease for a bearer credential, for the legacy thread-control transport. */
  authorize(credential: string, sourceToolCallId: string): InternalThreadControlAuthority | undefined {
    return authorizeEntry(this.findByCredential(credential), sourceToolCallId);
  }

  /** Returns the revocation signal for a bearer credential, for the legacy thread-control transport. */
  signalForCredential(credential: string): AbortSignal | undefined {
    return activeSignal(this.findByCredential(credential));
  }

  private findByCredential(credential: string): SessionEntry | undefined {
    const digest = digestOf(credential);
    let found: SessionEntry | undefined;
    for (const entry of this.entries.values()) {
      if (NodeCrypto.timingSafeEqual(entry.digest, digest)) found = entry;
    }
    return found;
  }
}

function activeSignal(entry: SessionEntry | undefined): AbortSignal | undefined {
  return entry?.active?.active ? entry.active.controller.signal : undefined;
}

function authorizeEntry(
  entry: SessionEntry | undefined,
  sourceToolCallId: string,
): InternalThreadControlAuthority | undefined {
  if (sourceToolCallId.length < 1 || sourceToolCallId.length > 128) return undefined;
  const lease = entry?.active;
  if (!lease?.active || !lease.eligible) return undefined;
  return {
    type: "internal",
    userId: "local-user",
    sourceThreadId: lease.sourceThreadId,
    sourceTurnId: lease.sourceTurnId,
    sourceToolCallId,
    sourceProviderId: lease.sourceProviderId,
    permissionMode: lease.permissionMode,
  };
}
