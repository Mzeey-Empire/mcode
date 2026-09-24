import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import {
  ExternalThreadControlPairingError,
  ExternalThreadControlPairingService,
  type ExternalThreadControlAuthenticatedPairing,
  type ExternalThreadControlPairingInput,
} from "../external-thread-control-pairing-service.js";

interface DeliverySeed {
  pairing_id: string;
  authority_epoch: number;
  delivery_id: string;
  fingerprint: string;
  status: "in_flight" | "terminal";
  result_json: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

function seedApprovalContext(db: Database): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("thread-1", "ws-1", "Test thread", "main", now, now);
}

function seedApproval(db: Database, callerId: string, status: string): void {
  seedApprovalContext(db);
  db.prepare(`INSERT INTO thread_control_approvals
    (id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, caller_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`approval-${callerId}`, "thread-1", "ws-1", "prompt", "{}", "{}", "turn-1", callerId, status, new Date().toISOString());
}

function approvalStatus(db: Database, callerId: string): string | undefined {
  const row = db.prepare("SELECT status FROM thread_control_approvals WHERE caller_id = ?").get(callerId) as { status: string } | null;
  return row?.status;
}

function insertDelivery(db: Database, seed: DeliverySeed): void {
  db.prepare(`INSERT INTO external_thread_control_deliveries
    (pairing_id, authority_epoch, delivery_id, fingerprint, status, result_json, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(seed.pairing_id, seed.authority_epoch, seed.delivery_id, seed.fingerprint, seed.status,
      seed.result_json, seed.created_at, seed.updated_at, seed.expires_at);
}

function deliveryRow(db: Database, pairingId: string, deliveryId: string): { status: string; result_json: string | null } | null {
  return db.prepare("SELECT status, result_json FROM external_thread_control_deliveries WHERE pairing_id = ? AND delivery_id = ?")
    .get(pairingId, deliveryId) as { status: string; result_json: string | null } | null;
}
const input = (overrides: Partial<ExternalThreadControlPairingInput> = {}): ExternalThreadControlPairingInput => ({
  integrationId: "integration-1",
  workspaceIds: ["workspace-1"],
  scopes: ["threads:read-project"],
  callsPerMinute: 10,
  maxActiveThreads: 2,
  ...overrides,
});

function authenticate(service: ExternalThreadControlPairingService, secret: string): ExternalThreadControlAuthenticatedPairing {
  return service.authenticate(secret);
}

describe("external thread-control pairing service", () => {
  it("rejects a second active pairing for one integration", () => {
    const db = openMemoryDatabase();
    const service = new ExternalThreadControlPairingService(db);
    const pairing = service.create(input());
    expect(() => service.create(input())).toThrowError(new ExternalThreadControlPairingError("conflict", "External integration already has an active pairing"));
    expect(() => service.replace(pairing.pairingId, input({ integrationId: "integration-2" }))).toThrowError("Pairing replacement must preserve integration identity");
  });

  it("does not let an old revoke cancel successor approvals", () => {
    const db = openMemoryDatabase();
    const service = new ExternalThreadControlPairingService(db);
    const old = service.create(input());
    const successor = service.replace(old.pairingId, input());
    seedApproval(db, "integration-1", "pending");
    expect(service.revoke(old.pairingId).status).toBe("revoked");
    expect(service.findById(successor.pairingId)?.status).toBe("active");
    expect(approvalStatus(db, "integration-1")).toBe("pending");
  });

  it("keeps rate reservations durable across service instances and free of duplicate charge", () => {
    const db = openMemoryDatabase();
    const firstService = new ExternalThreadControlPairingService(db);
    const secret = firstService.create(input({ callsPerMinute: 1 }));
    const authority = authenticate(firstService, secret.credential);
    expect(firstService.beginDelivery(authority, "delivery-1", "fingerprint").status).toBe("reserved");
    const secondService = new ExternalThreadControlPairingService(db);
    expect(secondService.beginDelivery(authority, "delivery-1", "fingerprint").status).toBe("joined");
    expect(() => secondService.beginDelivery(authority, "delivery-2", "fingerprint")).toThrowError("External call rate limit exceeded");
  });

  it("rejects a new delivery when all 10,000 retained slots are in flight", () => {
    const db = openMemoryDatabase();
    const service = new ExternalThreadControlPairingService(db);
    const secret = service.create(input());
    const authority = authenticate(service, secret.credential);
    const retainedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const insert = db.prepare(`INSERT INTO external_thread_control_deliveries
      (pairing_id, authority_epoch, delivery_id, fingerprint, status, result_json, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        insert.run(authority.pairing.pairingId, authority.pairing.authorityEpoch, `delivery-${index}`,
          "fingerprint", "in_flight", null, "2026-07-29T00:00:00.000Z", "2026-07-29T00:00:00.000Z", retainedUntil);
      }
    })();
    expect(() => service.beginDelivery(authority, "delivery-new", "fingerprint")).toThrowError("External replay retention is full");
  });

  it("terminalizes expired in-flight rows before capacity accounting and preserves replay", () => {
    const db = openMemoryDatabase();
    const service = new ExternalThreadControlPairingService(db);
    const secret = service.create(input());
    const authority = authenticate(service, secret.credential);
    insertDelivery(db, {
      pairing_id: authority.pairing.pairingId, authority_epoch: authority.pairing.authorityEpoch, delivery_id: "expired",
      fingerprint: "fingerprint", status: "in_flight", result_json: null,
      created_at: "2026-07-28T00:00:00.000Z", updated_at: "2026-07-28T00:00:00.000Z", expires_at: "2026-07-29T00:00:00.000Z",
    });
    const insert = db.prepare(`INSERT INTO external_thread_control_deliveries
      (pairing_id, authority_epoch, delivery_id, fingerprint, status, result_json, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (let index = 0; index < 9_999; index += 1) {
        insert.run(authority.pairing.pairingId, authority.pairing.authorityEpoch, `delivery-${index}`,
          "fingerprint", "in_flight", null, "2026-07-29T00:00:00.000Z", "2026-07-29T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
      }
    })();

    const replay = service.beginDelivery(authority, "expired", "fingerprint");
    expect(replay.status).toBe("replayed");
    expect(replay.result).toEqual({
      status: "rejected",
      error: { code: "internal_error", message: "External delivery expired before completion", retryable: true },
    });
    expect(deliveryRow(db, authority.pairing.pairingId, "expired")?.status).toBe("terminal");
    service.finalizeDelivery(authority, "expired", { status: "completed" });
    const expired = deliveryRow(db, authority.pairing.pairingId, "expired");
    expect(JSON.parse(expired?.result_json ?? "null")).toEqual(replay.result);
    expect(() => service.beginDelivery(authority, "delivery-new", "fingerprint")).not.toThrow();
  });
});
