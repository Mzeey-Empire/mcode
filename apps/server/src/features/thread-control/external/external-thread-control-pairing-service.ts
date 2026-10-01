import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import type { DatabaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { ExternalThreadControlPairingStore, ExternalThreadControlPairingError } from "./external-thread-control-pairing-store.js";
import { externalThreadControlPairingWriteOperations } from "./external-thread-control-pairing-write-operations.js";
export type { ExternalThreadControlPairingInput, ExternalThreadControlPairingRecord, ExternalThreadControlPairingSecret, ExternalThreadControlAuthenticatedPairing, ExternalThreadControlDeliveryResult } from "./external-thread-control-pairing-store.js";
export { ExternalThreadControlPairingError, externalThreadControlMcpEndpoint } from "./external-thread-control-pairing-store.js";

const pairingFailure = z.object({ name: z.literal("ExternalThreadControlPairingError"), message: z.string(), code: z.enum(["unauthorized", "stale_epoch", "conflict", "rate_limited", "replay_capacity"]), retryAfterSeconds: z.number().optional() });

/** Read-only queries and committed mutations for ExternalThreadControlPairingService. */
@injectable()
export class ExternalThreadControlPairingService {
  private readonly reader: ExternalThreadControlPairingStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ExternalThreadControlPairingStore(db);
  }

  private async execute<Input, Output>(operation: DatabaseWriteOperation<Input, Output>, input: Input): Promise<Output> {
    try {
      return await this.writer.execute(operation, input);
    } catch (error) {
      const parsed = pairingFailure.safeParse(error);
      if (parsed.success) throw new ExternalThreadControlPairingError(parsed.data.code, parsed.data.message, parsed.data.retryAfterSeconds);
      throw error;
    }
  }

  create(input: Parameters<ExternalThreadControlPairingStore["create"]>[0]): Promise<ReturnType<ExternalThreadControlPairingStore["create"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.create, [input]);
  }

  createPairing(input: Parameters<ExternalThreadControlPairingStore["createPairing"]>[0]): Promise<ReturnType<ExternalThreadControlPairingStore["createPairing"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.createPairing, [input]);
  }

  findById(pairingId: Parameters<ExternalThreadControlPairingStore["findById"]>[0]): ReturnType<ExternalThreadControlPairingStore["findById"]> {
    return this.reader.findById(pairingId);
  }

  revoke(pairingId: Parameters<ExternalThreadControlPairingStore["revoke"]>[0]): Promise<ReturnType<ExternalThreadControlPairingStore["revoke"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.revoke, [pairingId]);
  }

  revokePairing(pairingId: Parameters<ExternalThreadControlPairingStore["revokePairing"]>[0]): Promise<ReturnType<ExternalThreadControlPairingStore["revokePairing"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.revokePairing, [pairingId]);
  }

  replace(pairingId: Parameters<ExternalThreadControlPairingStore["replace"]>[0], input: Parameters<ExternalThreadControlPairingStore["replace"]>[1]): Promise<ReturnType<ExternalThreadControlPairingStore["replace"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.replace, [pairingId, input]);
  }

  replacePairing(pairingId: Parameters<ExternalThreadControlPairingStore["replacePairing"]>[0], input: Parameters<ExternalThreadControlPairingStore["replacePairing"]>[1]): Promise<ReturnType<ExternalThreadControlPairingStore["replacePairing"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.replacePairing, [pairingId, input]);
  }

  authenticate(credential: Parameters<ExternalThreadControlPairingStore["authenticate"]>[0], assertedPairingId?: Parameters<ExternalThreadControlPairingStore["authenticate"]>[1], assertedAuthorityEpoch?: Parameters<ExternalThreadControlPairingStore["authenticate"]>[2]): ReturnType<ExternalThreadControlPairingStore["authenticate"]> {
    return this.reader.authenticate(credential, assertedPairingId, assertedAuthorityEpoch);
  }

  authorize(credential: Parameters<ExternalThreadControlPairingStore["authorize"]>[0], assertedPairingId?: Parameters<ExternalThreadControlPairingStore["authorize"]>[1], assertedAuthorityEpoch?: Parameters<ExternalThreadControlPairingStore["authorize"]>[2]): ReturnType<ExternalThreadControlPairingStore["authorize"]> {
    return this.reader.authorize(credential, assertedPairingId, assertedAuthorityEpoch);
  }

  beginDelivery(pairing: Parameters<ExternalThreadControlPairingStore["beginDelivery"]>[0], deliveryId: Parameters<ExternalThreadControlPairingStore["beginDelivery"]>[1], fingerprint: Parameters<ExternalThreadControlPairingStore["beginDelivery"]>[2]): Promise<ReturnType<ExternalThreadControlPairingStore["beginDelivery"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.beginDelivery, [pairing, deliveryId, fingerprint]);
  }

  finalizeDelivery(pairing: Parameters<ExternalThreadControlPairingStore["finalizeDelivery"]>[0], deliveryId: Parameters<ExternalThreadControlPairingStore["finalizeDelivery"]>[1], result: Parameters<ExternalThreadControlPairingStore["finalizeDelivery"]>[2]): Promise<ReturnType<ExternalThreadControlPairingStore["finalizeDelivery"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.finalizeDelivery, [pairing, deliveryId, result]);
  }

  reconcileInFlight(): Promise<ReturnType<ExternalThreadControlPairingStore["reconcileInFlight"]>> {
    return this.execute(externalThreadControlPairingWriteOperations.reconcileInFlight, []);
  }
}
