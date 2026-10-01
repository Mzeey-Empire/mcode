import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { ApplicationDatabaseWriter, DatabaseWriteOutcomeUnknown, DatabaseWriterAdmissionFull } from "../application-database-writer.js";
import { executeOwnedDatabaseCommand } from "../owned-database-command.js";
import { openReadOnlyDatabase } from "../read-only-database.js";
import { databaseWriteOperation } from "../database-write-operation.js";
import { workspaceWriteOperations } from "../../../../features/projects/persistence/workspace-write-operations.js";
import { WorkspaceStore } from "../../../../features/projects/persistence/workspace-store.js";
import { WorkspaceRepo } from "../../../../features/projects/persistence/workspace-repo.js";
import { workspaces } from "../schema.js";
import type { ApplicationDatabaseWriterResponse } from "../application-database-writer-protocol.js";

describe("application SQLite owner", () => {
  let directory: string;
  let dbPath: string;
  let reader: Database;
  let owner: ApplicationDatabaseWriter | undefined;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-owner-"));
    dbPath = NodePath.join(directory, "app.sqlite");
    openDatabase({ dbPath }).close(true);
    reader = openReadOnlyDatabase(dbPath);
  });

  afterEach(async () => {
    await owner?.close();
    reader.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("shares ordered ordinary and canonical commands and continues after a rolled-back constraint failure", async () => {
    owner = new ApplicationDatabaseWriter(dbPath);
    const first = owner.execute(workspaceWriteOperations.create, ["First", "first", true]);
    const canonical = owner.sendCanonical({ kind: "ack-operation", requestId: "canonical-ack", operationId: "missing", executionId: "missing" });
    const failed = owner.execute(workspaceWriteOperations.create, ["Duplicate", "first", true]);
    const failedObserved = expect(failed).rejects.toThrow("UNIQUE");
    const last = owner.execute(workspaceWriteOperations.create, ["Last", "last", false]);
    expect(await first).toMatchObject({ name: "First", sort_order: 0 });
    expect(await canonical).toMatchObject({ kind: "operation-acknowledged" });
    await failedObserved;
    expect(await last).toMatchObject({ name: "Last", is_git_repo: false });
    expect(reader.query("SELECT name, sort_order FROM workspaces ORDER BY sort_order").all())
      .toEqual([{ name: "Last", sort_order: 0 }, { name: "First", sort_order: 1 }]);
  });

  it("rejects both direct and transaction writes on the physically read-only main connection", () => {
    expect(() => reader.run("DELETE FROM workspaces")).toThrow(/readonly/);
    expect(() => new WorkspaceStore(reader).create("Bypass", "bypass", true)).toThrow(/readonly/);
    expect(reader.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(reader.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(reader.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(reader.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  });

  it("returns committed workspace results through the asynchronous feature facade", async () => {
    owner = new ApplicationDatabaseWriter(dbPath);
    const repository = new WorkspaceRepo(reader, owner);
    const workspace = await repository.create("Feature path", directory, true);
    expect(repository.findById(workspace.id)).toEqual(workspace);
    await repository.setPinned(workspace.id, true);
    expect(repository.findById(workspace.id)?.pinned).toBe(true);
    expect(await repository.rename(workspace.id, "Renamed")).toMatchObject({ id: workspace.id, name: "Renamed" });
    expect(await repository.softDelete(workspace.id)).toBe(true);
    expect(repository.findById(workspace.id)).toBeNull();
  });

  it("bootstraps a new database entirely inside its owner before opening the reader", async () => {
    const freshPath = NodePath.join(directory, "fresh.sqlite");
    owner = new ApplicationDatabaseWriter(freshPath, undefined, { bootstrap: true });
    await owner.whenReady();
    const freshReader = openReadOnlyDatabase(freshPath);
    try {
      const workspace = await owner.execute(workspaceWriteOperations.create, ["Bootstrapped", "fresh", true]);
      expect(freshReader.query("SELECT name FROM workspaces WHERE id = ?").get(workspace.id)).toEqual({ name: "Bootstrapped" });
      expect(freshReader.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(() => freshReader.run("DELETE FROM workspaces")).toThrow(/readonly/);
    } finally { freshReader.close(true); }
  });

  it("faults the owner while retaining readonly main reads and restores following writes", async () => {
    owner = new ApplicationDatabaseWriter(dbPath);
    await owner.setQueryOnlyForReliability(true);
    await expect(owner.execute(workspaceWriteOperations.create, ["Rejected", "fault", true])).rejects.toThrow(/readonly/);
    expect(reader.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
    await owner.setQueryOnlyForReliability(false);
    expect(await owner.execute(workspaceWriteOperations.create, ["Restored", "restored", true])).toMatchObject({ name: "Restored" });
    expect(() => reader.run("DELETE FROM workspaces")).toThrow(/readonly/);
  });

  it("rolls back nested Bun and Drizzle transactions when output cannot cross the worker boundary", () => {
    const writer = new Database(dbPath, { strict: true });
    try {
      const workspace = new WorkspaceStore(writer);
      expect(() => executeOwnedDatabaseCommand(writer, () => {
        workspace.create("Nested workspace", "nested", true);
        writer.transaction(() => workspace.setPinned(workspace.findByPath("nested")!.id, true))();
        return { invalid: () => "uncloneable" };
      }, undefined)).toThrow();
      expect(reader.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
      expect(() => executeOwnedDatabaseCommand(writer, () => drizzle(writer).transaction((tx) => {
        tx.insert(workspaces).values({ id: "rollback", name: "Rollback", path: "rollback" }).run();
        throw new Error("Nested failure");
      }), undefined)).toThrow("Nested failure");
      expect(reader.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
      expect(executeOwnedDatabaseCommand(writer, () => workspace.create("Committed", "committed", false), undefined))
        .toMatchObject({ name: "Committed" });
      expect(reader.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    } finally { writer.close(true); }
  });

  it("keeps the main loop responsive during SQLite lock waiting and drains pending work before close", async () => {
    owner = new ApplicationDatabaseWriter(dbPath);
    await owner.whenReady();
    const peer = new Database(dbPath, { strict: true });
    peer.run("BEGIN IMMEDIATE");
    const pending = owner.execute(workspaceWriteOperations.create, ["Delayed", "delayed", true]);
    const closed = owner.close();
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reader.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
      peer.run("COMMIT");
      expect(await pending).toMatchObject({ name: "Delayed" });
      await closed;
      expect(reader.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    } finally { if (peer.inTransaction) peer.run("ROLLBACK"); peer.close(true); }
  });

  it("does not replay an ordinary commit after its reply is lost, and keeps unsent jobs in order", async () => {
    let workers = 0;
    owner = new ApplicationDatabaseWriter(dbPath, () => {
      const worker = new Worker(new URL("../../../../features/agents/canonical/canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
      if (++workers > 1) return worker;
      return new Proxy(worker, {
        set(target, property, value) {
          if (property !== "onmessage" || typeof value !== "function") return Reflect.set(target, property, value);
          target.onmessage = (message: MessageEvent<ApplicationDatabaseWriterResponse>) => {
            if (message.data.kind === "ordinary-written") { target.terminate(); return; }
            value(message);
          };
          return true;
        },
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const lost = owner.execute(workspaceWriteOperations.create, ["Lost reply", "lost-reply", true]);
    const observed = expect(lost).rejects.toBeInstanceOf(DatabaseWriteOutcomeUnknown);
    const tail = owner.execute(workspaceWriteOperations.create, ["Unsent", "unsent", true]);
    await observed;
    expect(await tail).toMatchObject({ name: "Unsent" });
    expect(workers).toBe(2);
    expect(reader.query("SELECT name FROM workspaces ORDER BY sort_order").all())
      .toEqual([{ name: "Unsent" }, { name: "Lost reply" }]);
  });

  it("accounts for retained bytes and rejects oversized data before dispatch", async () => {
    owner = new ApplicationDatabaseWriter(dbPath);
    await expect(owner.execute(workspaceWriteOperations.create, ["Large", "x".repeat(15 * 1024 * 1024), true]))
      .rejects.toBeInstanceOf(DatabaseWriterAdmissionFull);
    expect(reader.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
  });

  it("reports unknown when a committed ordinary reply has invalid output without replaying it", async () => {
    let corrupt = true;
    owner = new ApplicationDatabaseWriter(dbPath, () => {
      const worker = new Worker(new URL("../../../../features/agents/canonical/canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
      return new Proxy(worker, {
        set(target, property, value) {
          if (property !== "onmessage" || typeof value !== "function") return Reflect.set(target, property, value);
          target.onmessage = (message: MessageEvent<ApplicationDatabaseWriterResponse>) => {
            if (message.data.kind === "ordinary-written" && corrupt) {
              corrupt = false;
              value(new MessageEvent("message", { data: { ...message.data, result: null } }));
              return;
            }
            value(message);
          };
          return true;
        },
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const unknown = owner.execute(workspaceWriteOperations.create, ["Committed", "corrupt-reply", true]);
    const observed = expect(unknown).rejects.toBeInstanceOf(DatabaseWriteOutcomeUnknown);
    const tail = owner.execute(workspaceWriteOperations.create, ["Following", "following", true]);
    await observed;
    expect(await tail).toMatchObject({ name: "Following" });
    expect(reader.query("SELECT name FROM workspaces ORDER BY sort_order").all())
      .toEqual([{ name: "Following" }, { name: "Committed" }]);
  });

  it("rejects unregistered operations without poisoning subsequent writes", async () => {
    owner = new ApplicationDatabaseWriter(dbPath);
    const invalid = databaseWriteOperation("arbitrary.sql", z.string(), z.void());
    await expect(owner.execute(invalid, "DELETE FROM workspaces")).rejects.toThrow("not registered");
    expect(await owner.execute(workspaceWriteOperations.create, ["Allowed", "allowed", true])).toMatchObject({ name: "Allowed" });
  });
});
