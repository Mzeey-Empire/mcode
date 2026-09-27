import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { and, asc, count, eq, gt, inArray, lte } from "drizzle-orm";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";
import {
  externalThreadControlDeliveries,
  externalThreadControlPairings,
  threadControlApprovals,
} from "../../../runtime/persistence/sqlite/schema.js";
import type {
  ExternalThreadControlAuthority,
  ExternalThreadControlScope,
} from "@mcode/thread-orchestration";

const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_DELIVERIES_PER_INTEGRATION = 10_000;
const CREDENTIAL_BYTES = 32;
const EXTERNAL_MCP_ENDPOINT = "/mcp/external-thread-control";
const VALID_SCOPES = new Set<ExternalThreadControlScope>([
  "projects:read",
  "worktrees:read",
  "threads:create",
  "threads:read-owned",
  "threads:read-project",
  "threads:send-owned",
  "threads:send-project",
  "threads:stop-owned",
  "threads:stop-project",
  "worktrees:create",
  "execution:full",
]);

type PairingStatus = "active" | "revoked";

/** Input used by the authenticated local pairing-management methods. */
export interface ExternalThreadControlPairingInput {
  integrationId: string;
  workspaceIds: readonly string[];
  scopes: readonly ExternalThreadControlScope[];
  callsPerMinute: number;
  maxActiveThreads: number;
}

/** Durable pairing record. Credential material is intentionally absent. */
export interface ExternalThreadControlPairingRecord {
  pairingId: string;
  integrationId: string;
  workspaceIds: readonly string[];
  scopes: readonly ExternalThreadControlScope[];
  callsPerMinute: number;
  maxActiveThreads: number;
  status: PairingStatus;
  authorityEpoch: number;
  createdAt: string;
  updatedAt: string;
  replacedByPairingId?: string;
  replacesPairingId?: string;
}

/** Pairing record plus one-time plaintext credential returned by creation. */
export interface ExternalThreadControlPairingSecret extends ExternalThreadControlPairingRecord {
  credential: string;
  externalMcpEndpoint: string;
}

/** Authenticated, server-derived authority accepted by ThreadControlService. */
export interface ExternalThreadControlAuthenticatedPairing {
  pairing: ExternalThreadControlPairingRecord;
  authority: ExternalThreadControlAuthority;
}

/** One durable replay result returned by delivery reservation. */
export interface ExternalThreadControlDeliveryResult {
  status: "replayed" | "joined" | "reserved";
  key: string;
  result?: Record<string, unknown>;
}

/** Errors raised by pairing authentication, replay, and rate-limit boundaries. */
export class ExternalThreadControlPairingError extends Error {
  constructor(
    readonly code: "unauthorized" | "stale_epoch" | "conflict" | "rate_limited" | "replay_capacity",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ExternalThreadControlPairingError";
  }
}

interface PairingRow {
  pairingId: string;
  integrationId: string;
  credentialHash: string;
  workspaceIdsJson: string;
  scopesJson: string;
  callsPerMinute: number;
  maxActiveThreads: number;
  status: PairingStatus;
  authorityEpoch: number;
  createdAt: string;
  updatedAt: string;
  replacedByPairingId: string | null;
  replacesPairingId: string | null;
}

type DeliveryRow = typeof externalThreadControlDeliveries.$inferSelect;

/** Owns durable external pairings, credential hashing, replay retention, and rate reservations. */
@injectable()
export class ExternalThreadControlPairingService {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") private readonly db: Database) {
    this.orm = drizzle(db);
  }

  /** Create a pairing and return its plaintext credential exactly once. */
  create(input: ExternalThreadControlPairingInput): ExternalThreadControlPairingSecret {
    const normalized = normalizePairingInput(input);
    const pairingId = NodeCrypto.randomUUID();
    const credential = NodeCrypto.randomBytes(CREDENTIAL_BYTES).toString("base64url");
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      const active = this.orm.select({ pairingId: externalThreadControlPairings.pairingId })
        .from(externalThreadControlPairings)
        .where(and(
          eq(externalThreadControlPairings.integrationId, normalized.integrationId),
          eq(externalThreadControlPairings.status, "active"),
        ))
        .limit(1)
        .get();
      if (active) {
        throw new ExternalThreadControlPairingError("conflict", "External integration already has an active pairing");
      }
      this.orm.insert(externalThreadControlPairings).values({
        pairingId,
        integrationId: normalized.integrationId,
        credentialHash: hashCredential(credential),
        workspaceIdsJson: JSON.stringify(normalized.workspaceIds),
        scopesJson: JSON.stringify(normalized.scopes),
        callsPerMinute: normalized.callsPerMinute,
        maxActiveThreads: normalized.maxActiveThreads,
        status: "active",
        authorityEpoch: 1,
        createdAt: now,
        updatedAt: now,
      }).run();
    });
    create();
    return { ...this.requireById(pairingId), credential, externalMcpEndpoint: EXTERNAL_MCP_ENDPOINT };
  }

  /** Named alias used by management callers that model pairings as resources. */
  createPairing(input: ExternalThreadControlPairingInput): ExternalThreadControlPairingSecret {
    return this.create(input);
  }

  /** Look up a pairing without exposing its credential hash. */
  findById(pairingId: string): ExternalThreadControlPairingRecord | undefined {
    const row = this.orm.select().from(externalThreadControlPairings)
      .where(eq(externalThreadControlPairings.pairingId, pairingId))
      .get() as PairingRow | undefined;
    return row ? rowToPairing(row) : undefined;
  }

  /** Revoke one pairing. Repeated revocation is idempotent. */
  revoke(pairingId: string): ExternalThreadControlPairingRecord {
    const pairing = this.requireById(pairingId);
    const now = new Date().toISOString();
    const revoke = this.db.transaction(() => {
      const result = runChanges(this.orm.update(externalThreadControlPairings)
        .set({ status: "revoked", updatedAt: now })
        .where(and(
          eq(externalThreadControlPairings.pairingId, pairingId),
          eq(externalThreadControlPairings.status, "active"),
        )));
      if (result.changes === 1 && pairing.status === "active") {
        this.orm.update(threadControlApprovals)
          .set({ status: "failed", resolvedAt: now })
          .where(and(
            eq(threadControlApprovals.callerId, pairing.integrationId),
            inArray(threadControlApprovals.status, ["pending", "processing"]),
          ))
          .run();
      }
    });
    revoke();
    return this.requireById(pairingId);
  }

  /** Named alias used by management callers that model pairings as resources. */
  revokePairing(pairingId: string): ExternalThreadControlPairingRecord {
    return this.revoke(pairingId);
  }

  /** Atomically revoke old authority and create a successor with the next epoch. */
  replace(pairingId: string, input: ExternalThreadControlPairingInput): ExternalThreadControlPairingSecret {
    const old = this.requireById(pairingId);
    if (old.status !== "active") {
      throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
    }
    const normalized = normalizePairingInput(input);
    if (normalized.integrationId !== old.integrationId) {
      throw new ExternalThreadControlPairingError("conflict", "Pairing replacement must preserve integration identity");
    }
    const successorId = NodeCrypto.randomUUID();
    const credential = NodeCrypto.randomBytes(CREDENTIAL_BYTES).toString("base64url");
    const now = new Date().toISOString();
    const replace = this.db.transaction(() => {
      const result = runChanges(this.orm.update(externalThreadControlPairings)
        .set({ status: "revoked", replacedByPairingId: successorId, updatedAt: now })
        .where(and(
          eq(externalThreadControlPairings.pairingId, pairingId),
          eq(externalThreadControlPairings.status, "active"),
        )));
      if (result.changes !== 1) {
        throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
      }
      // Pending approvals are pre-dispatch external work. Replacement closes
      // them before successor authority becomes visible, preventing a late
      // callback from dispatching under the revoked epoch.
      this.orm.update(threadControlApprovals)
        .set({ status: "failed", resolvedAt: now })
        .where(and(
          eq(threadControlApprovals.callerId, old.integrationId),
          inArray(threadControlApprovals.status, ["pending", "processing"]),
        ))
        .run();
      this.orm.insert(externalThreadControlPairings).values({
        pairingId: successorId,
        integrationId: normalized.integrationId,
        credentialHash: hashCredential(credential),
        workspaceIdsJson: JSON.stringify(normalized.workspaceIds),
        scopesJson: JSON.stringify(normalized.scopes),
        callsPerMinute: normalized.callsPerMinute,
        maxActiveThreads: normalized.maxActiveThreads,
        status: "active",
        authorityEpoch: old.authorityEpoch + 1,
        createdAt: now,
        updatedAt: now,
        replacesPairingId: pairingId,
      }).run();
    });
    replace();
    return { ...this.requireById(successorId), credential, externalMcpEndpoint: EXTERNAL_MCP_ENDPOINT };
  }

  /** Named alias for atomic pairing replacement. */
  replacePairing(pairingId: string, input: ExternalThreadControlPairingInput): ExternalThreadControlPairingSecret {
    return this.replace(pairingId, input);
  }

  /** Derive identity and epoch from credential before any replay lookup. */
  authenticate(
    credential: string,
    assertedPairingId?: string,
    assertedAuthorityEpoch?: number,
  ): ExternalThreadControlAuthenticatedPairing {
    if (credential.length < 1 || credential.length > 256) {
      throw new ExternalThreadControlPairingError("unauthorized", "External thread-control pairing denied");
    }
    const digest = hashCredential(credential);
    const row = this.orm.select().from(externalThreadControlPairings)
      .where(eq(externalThreadControlPairings.credentialHash, digest))
      .get() as PairingRow | undefined;
    if (!row || !constantTimeHashEqual(row.credentialHash, digest)) {
      throw new ExternalThreadControlPairingError("unauthorized", "External thread-control pairing denied");
    }
    if (row.status !== "active") {
      throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
    }
    if (assertedPairingId !== undefined && assertedPairingId !== row.pairingId) {
      throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
    }
    if (assertedAuthorityEpoch !== undefined && assertedAuthorityEpoch !== row.authorityEpoch) {
      throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
    }
    const pairing = rowToPairing(row);
    return {
      pairing,
      authority: {
        type: "external",
        pairingId: pairing.pairingId,
        authorityEpoch: pairing.authorityEpoch,
        integrationId: pairing.integrationId,
        allowedWorkspaceIds: pairing.workspaceIds,
        scopes: pairing.scopes,
        limits: {
          callsPerMinute: pairing.callsPerMinute,
          maxActiveThreads: pairing.maxActiveThreads,
        },
      },
    };
  }

  /** Named alias emphasizing that callers receive derived authority, not grants. */
  authorize(
    credential: string,
    assertedPairingId?: string,
    assertedAuthorityEpoch?: number,
  ): ExternalThreadControlAuthenticatedPairing {
    return this.authenticate(credential, assertedPairingId, assertedAuthorityEpoch);
  }

  /** Reserve one delivery, joining or replaying an existing key without rate cost. */
  beginDelivery(
    pairing: ExternalThreadControlAuthenticatedPairing,
    deliveryId: string,
    fingerprint: string,
  ): ExternalThreadControlDeliveryResult {
    if (!/^[\x21-\x7e]{1,256}$/.test(deliveryId)) {
      throw new ExternalThreadControlPairingError("conflict", "External delivery id is invalid");
    }
    if (fingerprint.length < 1 || fingerprint.length > 256) {
      throw new ExternalThreadControlPairingError("conflict", "External delivery fingerprint is invalid");
    }
    const key = `${pairing.pairing.pairingId}:${pairing.pairing.authorityEpoch}:${deliveryId}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + DELIVERY_RETENTION_MS).toISOString();
    const reserve = this.db.transaction(() => {
      this.orm.delete(externalThreadControlDeliveries)
        .where(and(
          eq(externalThreadControlDeliveries.status, "terminal"),
          lte(externalThreadControlDeliveries.expiresAt, nowIso),
        ))
        .run();
      this.orm.update(externalThreadControlDeliveries)
        .set({
          status: "terminal",
          resultJson: JSON.stringify({ status: "rejected", error: { code: "internal_error", message: "External delivery expired before completion", retryable: true } }),
          updatedAt: nowIso,
        })
        .where(and(
          eq(externalThreadControlDeliveries.status, "in_flight"),
          lte(externalThreadControlDeliveries.expiresAt, nowIso),
        ))
        .run();
      const existing = this.orm.select().from(externalThreadControlDeliveries)
        .where(and(
          eq(externalThreadControlDeliveries.pairingId, pairing.pairing.pairingId),
          eq(externalThreadControlDeliveries.authorityEpoch, pairing.pairing.authorityEpoch),
          eq(externalThreadControlDeliveries.deliveryId, deliveryId),
        ))
        .get() as DeliveryRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new ExternalThreadControlPairingError("conflict", "External delivery fingerprint conflict");
        }
        return existing;
      }
      const pairingJoin = eq(
        externalThreadControlDeliveries.pairingId,
        externalThreadControlPairings.pairingId,
      );
      const countRow = this.orm.select({ count: count() })
        .from(externalThreadControlDeliveries)
        .innerJoin(externalThreadControlPairings, pairingJoin)
        .where(eq(externalThreadControlPairings.integrationId, pairing.pairing.integrationId))
        .get();
      if ((countRow?.count ?? 0) >= MAX_DELIVERIES_PER_INTEGRATION) {
        const removable = this.orm.select({
          pairingId: externalThreadControlDeliveries.pairingId,
          authorityEpoch: externalThreadControlDeliveries.authorityEpoch,
          deliveryId: externalThreadControlDeliveries.deliveryId,
        })
          .from(externalThreadControlDeliveries)
          .innerJoin(externalThreadControlPairings, pairingJoin)
          .where(and(
            eq(externalThreadControlPairings.integrationId, pairing.pairing.integrationId),
            eq(externalThreadControlDeliveries.status, "terminal"),
          ))
          .orderBy(asc(externalThreadControlDeliveries.updatedAt))
          .limit(1)
          .get();
        if (!removable) {
          throw new ExternalThreadControlPairingError("replay_capacity", "External replay retention is full", 60);
        }
        this.orm.delete(externalThreadControlDeliveries)
          .where(and(
            eq(externalThreadControlDeliveries.pairingId, removable.pairingId),
            eq(externalThreadControlDeliveries.authorityEpoch, removable.authorityEpoch),
            eq(externalThreadControlDeliveries.deliveryId, removable.deliveryId),
            eq(externalThreadControlDeliveries.status, "terminal"),
          ))
          .run();
      }
      const cutoffIso = new Date(now.getTime() - 60_000).toISOString();
      const recent = this.orm.select({ count: count() })
        .from(externalThreadControlDeliveries)
        .innerJoin(externalThreadControlPairings, pairingJoin)
        .where(and(
          eq(externalThreadControlPairings.integrationId, pairing.pairing.integrationId),
          gt(externalThreadControlDeliveries.createdAt, cutoffIso),
        ))
        .get();
      if ((recent?.count ?? 0) >= pairing.pairing.callsPerMinute) {
        throw new ExternalThreadControlPairingError("rate_limited", "External call rate limit exceeded", 60);
      }
      this.orm.insert(externalThreadControlDeliveries).values({
        pairingId: pairing.pairing.pairingId,
        authorityEpoch: pairing.pairing.authorityEpoch,
        deliveryId,
        fingerprint,
        status: "in_flight",
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt,
      }).run();
      return undefined;
    })();
    if (reserve?.status === "terminal") {
      return { status: "replayed", key, result: parseResult(reserve.resultJson) };
    }
    if (reserve?.status === "in_flight") return { status: "joined", key };
    return { status: "reserved", key };
  }

  /** Persist one terminal replay result. Safe to call repeatedly for one delivery. */
  finalizeDelivery(pairing: ExternalThreadControlAuthenticatedPairing, deliveryId: string, result: Record<string, unknown>): void {
    const resultJson = JSON.stringify(result);
    const now = new Date().toISOString();
    this.orm.update(externalThreadControlDeliveries)
      .set({ status: "terminal", resultJson, updatedAt: now })
      .where(and(
        eq(externalThreadControlDeliveries.pairingId, pairing.pairing.pairingId),
        eq(externalThreadControlDeliveries.authorityEpoch, pairing.pairing.authorityEpoch),
        eq(externalThreadControlDeliveries.deliveryId, deliveryId),
        eq(externalThreadControlDeliveries.status, "in_flight"),
      ))
      .run();
  }

  /** Reconcile uncertain work after restart without redispatching it. */
  reconcileInFlight(): number {
    const result = runChanges(this.orm.update(externalThreadControlDeliveries)
      .set({
        status: "terminal",
        resultJson: JSON.stringify({ status: "rejected", error: { code: "internal_error", message: "External delivery outcome was reconciled after restart", retryable: true } }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(externalThreadControlDeliveries.status, "in_flight")));
    return result.changes;
  }

  private requireById(pairingId: string): ExternalThreadControlPairingRecord {
    const pairing = this.findById(pairingId);
    if (!pairing) throw new ExternalThreadControlPairingError("unauthorized", "External thread-control pairing not found");
    return pairing;
  }
}

function normalizePairingInput(input: ExternalThreadControlPairingInput): ExternalThreadControlPairingInput {
  const integrationId = input.integrationId.trim();
  const workspaceIds = normalizeWorkspaceIds(input.workspaceIds);
  const scopes = [...new Set(input.scopes)];
  if (!isValidPairingPolicy(input, integrationId, workspaceIds, scopes)) {
    throw new ExternalThreadControlPairingError("conflict", "External pairing policy is invalid");
  }
  return {
    integrationId,
    workspaceIds,
    scopes,
    callsPerMinute: Math.trunc(input.callsPerMinute),
    maxActiveThreads: Math.trunc(input.maxActiveThreads),
  };
}

function normalizeWorkspaceIds(workspaceIds: readonly string[]): string[] {
  return [...new Set(workspaceIds.map((value) => value.trim()).filter(Boolean))];
}

function isValidPairingPolicy(
  input: ExternalThreadControlPairingInput,
  integrationId: string,
  workspaceIds: string[],
  scopes: ExternalThreadControlScope[],
): boolean {
  return isValidIntegrationId(integrationId)
    && isValidWorkspaceIds(workspaceIds)
    && scopes.every((scope) => VALID_SCOPES.has(scope))
    && isIntegerWithin(input.callsPerMinute, 1, 10_000)
    && isIntegerWithin(input.maxActiveThreads, 1, 1_000);
}

function isValidIntegrationId(integrationId: string): boolean {
  return integrationId.length > 0 && integrationId.length <= 128;
}

function isValidWorkspaceIds(workspaceIds: string[]): boolean {
  return workspaceIds.length <= 100 && workspaceIds.every((workspaceId) => workspaceId.length <= 128);
}

function isIntegerWithin(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function rowToPairing(row: PairingRow): ExternalThreadControlPairingRecord {
  const workspaceIds = JSON.parse(row.workspaceIdsJson) as string[];
  const scopes = JSON.parse(row.scopesJson) as ExternalThreadControlScope[];
  return {
    pairingId: row.pairingId,
    integrationId: row.integrationId,
    workspaceIds,
    scopes,
    callsPerMinute: row.callsPerMinute,
    maxActiveThreads: row.maxActiveThreads,
    status: row.status,
    authorityEpoch: row.authorityEpoch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.replacedByPairingId ? { replacedByPairingId: row.replacedByPairingId } : {}),
    ...(row.replacesPairingId ? { replacesPairingId: row.replacesPairingId } : {}),
  };
}

function hashCredential(credential: string): string {
  return NodeCrypto.createHash("sha256").update(credential, "utf8").digest("hex");
}

function constantTimeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseResult(resultJson: string | null): Record<string, unknown> {
  if (!resultJson) return { status: "rejected", error: { code: "internal_error", message: "External delivery outcome unavailable", retryable: true } };
  try {
    const value = JSON.parse(resultJson) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : { status: "rejected", error: { code: "internal_error", message: "External delivery outcome invalid", retryable: true } };
  } catch {
    return { status: "rejected", error: { code: "internal_error", message: "External delivery outcome invalid", retryable: true } };
  }
}

/** Return the loopback path used by the external MCP adapter. */
export function externalThreadControlMcpEndpoint(): string {
  return EXTERNAL_MCP_ENDPOINT;
}
