import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { ExternalThreadControlPairingStore } from "./external-thread-control-pairing-store.js";
import { externalThreadControlPairingWriteOperations } from "./external-thread-control-pairing-write-operations.js";

/** Register synchronous complete operations on the application writer connection. */
export function buildExternalThreadControlPairingStoreWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ExternalThreadControlPairingStore(db);
  return new Map<string, (input: unknown) => unknown>([
    [externalThreadControlPairingWriteOperations.create.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.create, (input) => store.create(...input))],
    [externalThreadControlPairingWriteOperations.createPairing.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.createPairing, (input) => store.createPairing(...input))],
    [externalThreadControlPairingWriteOperations.revoke.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.revoke, (input) => store.revoke(...input))],
    [externalThreadControlPairingWriteOperations.revokePairing.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.revokePairing, (input) => store.revokePairing(...input))],
    [externalThreadControlPairingWriteOperations.replace.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.replace, (input) => store.replace(...input))],
    [externalThreadControlPairingWriteOperations.replacePairing.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.replacePairing, (input) => store.replacePairing(...input))],
    [externalThreadControlPairingWriteOperations.beginDelivery.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.beginDelivery, (input) => store.beginDelivery(...input))],
    [externalThreadControlPairingWriteOperations.finalizeDelivery.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.finalizeDelivery, (input) => store.finalizeDelivery(...input))],
    [externalThreadControlPairingWriteOperations.reconcileInFlight.name, databaseWriteHandler(externalThreadControlPairingWriteOperations.reconcileInFlight, (input) => store.reconcileInFlight(...input))],
  ]);
}
