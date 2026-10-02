import type { Database } from "bun:sqlite";
import type { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { TerminalCleanupLedgerStore, type PtyHostCleanupRecord } from "./terminal-cleanup-ledger-store.js";
import { terminalCleanupLedgerWriteOperations } from "./terminal-cleanup-ledger-write-operations.js";
export type { PtyHostCleanupRecord } from "./terminal-cleanup-ledger-store.js";

/** Persistence seam requiring committed process identity before running acknowledgment. */
export interface PtyHostCleanupLedgerStore {
  record(record: PtyHostCleanupRecord): Promise<void>;
  remove(sessionId: string, hostGeneration: string): Promise<boolean>;
  get(sessionId: string): PtyHostCleanupRecord | null;
  list(): readonly PtyHostCleanupRecord[];
  forGeneration(hostGeneration: string): readonly PtyHostCleanupRecord[];
}

/** Bounded cleanup ledger whose mutations use the shared database owner. */
export class PtyHostCleanupLedger implements PtyHostCleanupLedgerStore {
  private readonly reader: TerminalCleanupLedgerStore;

  constructor(db: Database, private readonly writer: ApplicationDatabaseWriter, private readonly limit = 20) {
    this.reader = new TerminalCleanupLedgerStore(db, limit);
  }

  /** Commit process identity before the host is acknowledged as running. */
  record(record: PtyHostCleanupRecord): Promise<void> { return this.writer.execute(terminalCleanupLedgerWriteOperations.record, [record, this.limit]); }

  /** Remove a matching generation only after cleanup completes. */
  remove(sessionId: string, hostGeneration: string): Promise<boolean> { return this.writer.execute(terminalCleanupLedgerWriteOperations.remove, [sessionId, hostGeneration]); }

  /** Read one retained process identity. */
  get(sessionId: string): PtyHostCleanupRecord | null { return this.reader.get(sessionId); }

  /** Read retained process identities. */
  list(): readonly PtyHostCleanupRecord[] { return this.reader.list(); }

  /** Read retained process identities for a generation. */
  forGeneration(hostGeneration: string): readonly PtyHostCleanupRecord[] { return this.reader.forGeneration(hostGeneration); }
}
