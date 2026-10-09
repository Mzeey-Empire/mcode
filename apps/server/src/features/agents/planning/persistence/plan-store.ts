import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as NodeCrypto from "node:crypto";
import { PlanVersionSchema, type PlanSaveVersion, type PlanVersion, type ProviderId } from "@mcode/contracts";
import { plans, canonicalAgentItems } from "../../../../runtime/persistence/sqlite/schema.js";
import { readCanonicalPlan } from "../legacy-plan-record.js";
import { mergePlanVersions } from "../merge-plan-versions.js";
import { planTitle } from "../plan-title.js";
import type { PlanPersistenceReady } from "../plan-execution-state.js";
import type { PlanSaveResult, PlanSnapshotResult } from "./plan-write-operations.js";

/** Plan queries and transactional operations, used on the application's sole writer. */
export class PlanStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(private readonly db: Database) { this.orm = drizzle(db); }

  /** Allocate an agent version and retire its mutable/reviewable predecessors. */
  create(threadId: string, messageId: string, capture: PlanPersistenceReady, providerId: ProviderId | null): PlanVersion {
    return this.db.transaction(() => {
      const prior = this.listByThread(threadId);
      const now = new Date().toISOString();
      for (const plan of prior) {
        if (plan.status === "draft" || plan.status === "ready") {
          this.orm.update(plans).set({ status: "superseded", updatedAt: now }).where(eq(plans.id, plan.id)).run();
        }
      }
      const version: PlanVersion = { id: NodeCrypto.randomUUID(), threadId, messageId,
        version: (prior.at(-1)?.version ?? 0) + 1, title: capture.title, contentMd: capture.contentMd,
        status: "ready", author: "agent", providerId, captureSource: capture.captureSource,
        baseVersionId: null, revision: 0, createdAt: now, updatedAt: now, acceptedAt: null, acceptedMessageId: null };
      this.insert(version, capture.nativePlanFile ? JSON.stringify(capture.nativePlanFile) : null);
      return version;
    })();
  }

  /** Checks busy and revision preconditions in the same transaction as the save. */
  saveVersion(input: PlanSaveVersion): PlanSaveResult {
    return this.db.transaction((): PlanSaveResult => {
      if (!this.threadExists(input.threadId)) return { ok: false, code: "thread_not_found", latestVersion: null };
      const latest = this.listByThread(input.threadId).at(-1) ?? null;
      if (this.db.prepare("SELECT 1 FROM canonical_agent_ingest_checkpoints WHERE thread_id = ? AND terminal_outcome IS NULL LIMIT 1").get(input.threadId)) {
        return { ok: false, code: "plan_busy", latestVersion: latest };
      }
      return this.saveAvailableVersion(input, latest);
    })();
  }

  private saveAvailableVersion(input: PlanSaveVersion, latest: PlanVersion | null): PlanSaveResult {
    const existing = this.getById(input.versionId);
    const base = this.getById(input.baseVersionId);
    if (isAcceptedVersion(input.threadId, base) || isAcceptedVersion(input.threadId, existing)) {
      return { ok: false, code: "plan_read_only", latestVersion: latest };
    }
    if (existing) return this.saveDraft(input, existing, latest);
    if (!latest || latest.id !== input.baseVersionId || latest.status !== "ready" || latest.revision !== input.baseRevision) {
      return { ok: false, code: "plan_conflict", latestVersion: latest };
    }
    const now = new Date().toISOString();
    const version: PlanVersion = { id: input.versionId, threadId: input.threadId, messageId: null,
      version: latest.version + 1, title: planTitle(input.contentMd), contentMd: input.contentMd,
      status: "draft", author: "user", providerId: null, captureSource: "edit", baseVersionId: latest.id,
      revision: 1, createdAt: now, updatedAt: now, acceptedAt: null, acceptedMessageId: null };
    this.insert(version);
    return { ok: true, version };
  }

  private saveDraft(input: PlanSaveVersion, existing: PlanVersion, latest: PlanVersion | null): PlanSaveResult {
    const conflict: PlanSaveResult = { ok: false, code: "plan_conflict", latestVersion: latest };
    if (existing.threadId !== input.threadId || existing.status !== "draft" || existing.id !== latest?.id) return conflict;
    if (existing.revision === input.baseRevision + 1 && existing.contentMd === input.contentMd) return { ok: true, version: existing };
    if (existing.revision !== input.baseRevision) return conflict;
    const version = { ...existing, title: planTitle(input.contentMd), contentMd: input.contentMd,
      revision: existing.revision + 1, updatedAt: new Date().toISOString() };
    this.orm.update(plans).set({ title: version.title, contentMd: version.contentMd,
      revision: version.revision, updatedAt: version.updatedAt }).where(eq(plans.id, existing.id)).run();
    return { ok: true, version };
  }

  /** Serializes the snapshot behind preceding writes and merges retained canonical history. */
  snapshot(threadId: string): PlanSnapshotResult {
    return this.db.transaction((): PlanSnapshotResult => {
      if (!this.threadExists(threadId)) return { ok: false, code: "thread_not_found", latestVersion: null };
      const historic: PlanVersion[] = [];
      for (const item of this.orm.select().from(canonicalAgentItems).where(eq(canonicalAgentItems.threadId, threadId)).orderBy(asc(canonicalAgentItems.updatedAt)).all()) {
        const payload: unknown = JSON.parse(item.payloadJson);
        if (typeof payload === "object" && payload !== null && "projection" in payload && payload.projection === "plan" && "plan" in payload) {
          const plan = readCanonicalPlan(payload.plan);
          if (plan.threadId !== threadId) throw new Error("Canonical plan belongs to another thread");
          historic.push(plan);
        }
      }
      return { ok: true, versions: mergePlanVersions(historic, this.listByThread(threadId)) };
    })();
  }

  private threadExists(threadId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM threads WHERE id = ? AND deleted_at IS NULL").get(threadId));
  }

  /** Insert an assigned version without allocating another identity. */
  insert(version: PlanVersion, nativePlanFileJson: string | null = null): void {
    this.orm.insert(plans).values({ ...version, nativePlanFileJson }).run();
  }

  /** All durable versions in their per-thread order. */
  listByThread(threadId: string): PlanVersion[] {
    return this.orm.select().from(plans).where(eq(plans.threadId, threadId)).orderBy(asc(plans.version)).all().map(toVersion);
  }

  /** Latest version eligible for the Mcode plan-file projection. */
  getLatestForThread(threadId: string): PlanVersion | null {
    const row = this.orm.select().from(plans).where(and(eq(plans.threadId, threadId), ne(plans.status, "superseded")))
      .orderBy(desc(plans.version)).get();
    return row ? toVersion(row) : null;
  }

  /** Find one assigned version. */
  getById(id: string): PlanVersion | null {
    const row = this.orm.select().from(plans).where(eq(plans.id, id)).get();
    return row ? toVersion(row) : null;
  }

  /** Find the agent version tied to an assistant message. */
  getByMessageId(messageId: string): PlanVersion | null {
    const row = this.orm.select().from(plans).where(eq(plans.messageId, messageId)).get();
    return row ? toVersion(row) : null;
  }
}

function toVersion(row: typeof plans.$inferSelect): PlanVersion {
  return PlanVersionSchema().parse({ ...row, acceptedMessageId: null });
}

function isAcceptedVersion(threadId: string, version: PlanVersion | null): boolean {
  return version?.threadId === threadId && version.status === "accepted";
}
