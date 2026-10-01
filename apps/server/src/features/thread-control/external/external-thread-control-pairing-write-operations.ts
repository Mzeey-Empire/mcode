import { z } from "zod";
import { databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";

const scope = z.enum(["projects:read", "worktrees:read", "threads:create", "threads:read-owned", "threads:read-project", "threads:send-owned", "threads:send-project", "threads:stop-owned", "threads:stop-project", "worktrees:create", "execution:full"]);
const limits = { callsPerMinute: z.number(), maxActiveThreads: z.number() };
const input = z.object({ integrationId: z.string(), workspaceIds: z.array(z.string()).readonly(), scopes: z.array(scope).readonly(), ...limits });
const record = input.extend({ pairingId: z.string(), status: z.enum(["active", "revoked"]), authorityEpoch: z.number().int(), createdAt: z.string(), updatedAt: z.string(), replacedByPairingId: z.string().optional(), replacesPairingId: z.string().optional() });
const secret = record.extend({ credential: z.string(), externalMcpEndpoint: z.string() });
const authenticated = z.object({
  pairing: record,
  authority: z.object({ type: z.literal("external"), pairingId: z.string().optional(), authorityEpoch: z.number().optional(), integrationId: z.string(), allowedWorkspaceIds: z.array(z.string()).readonly(), scopes: z.array(scope).readonly(), limits: z.object(limits) }),
});
const replayResult = z.record(z.string(), z.unknown());

/** Pairing and replay decisions remain complete transactional writer operations. */
export const externalThreadControlPairingWriteOperations = {
  create: databaseWriteOperation("externalThreadControlPairing.create", z.tuple([input]), secret),
  createPairing: databaseWriteOperation("externalThreadControlPairing.createPairing", z.tuple([input]), secret),
  revoke: databaseWriteOperation("externalThreadControlPairing.revoke", z.tuple([z.string()]), record),
  revokePairing: databaseWriteOperation("externalThreadControlPairing.revokePairing", z.tuple([z.string()]), record),
  replace: databaseWriteOperation("externalThreadControlPairing.replace", z.tuple([z.string(), input]), secret),
  replacePairing: databaseWriteOperation("externalThreadControlPairing.replacePairing", z.tuple([z.string(), input]), secret),
  beginDelivery: databaseWriteOperation("externalThreadControlPairing.beginDelivery", z.tuple([authenticated, z.string(), z.string()]), z.object({ status: z.enum(["replayed", "joined", "reserved"]), key: z.string(), result: replayResult.optional() })),
  finalizeDelivery: databaseWriteOperation("externalThreadControlPairing.finalizeDelivery", z.tuple([authenticated, z.string(), replayResult]), z.void()),
  reconcileInFlight: databaseWriteOperation("externalThreadControlPairing.reconcileInFlight", z.tuple([]), z.number().int()),
};
