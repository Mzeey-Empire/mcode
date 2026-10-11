import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import type { TurnSteerOutcome, TurnSteerParams } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import type { AcceptedSteerMessage } from "../../canonical/canonical-accepted-progress.js";
import { TurnSteerRepo } from "../../steering/persistence/turn-steer-repo.js";
import { TurnSteerStore } from "../../steering/persistence/turn-steer-store.js";
import type { SteerableTurn, TurnSteerMessage, TurnSteerRuntime } from "../../steering/turn-steer-runtime-port.js";
import { TurnSteerFaultStop, TurnSteerService } from "../../steering/turn-steer-service.js";

const NOW = "2026-10-11T09:00:00.000Z";
const THREAD = "thread-steer";
const EXECUTION = "execution-running";
const STEER_ID = "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const steerParams = (overrides: Partial<TurnSteerParams> = {}): TurnSteerParams => ({
  threadId: THREAD, turnExecutionId: EXECUTION, messageId: STEER_ID, content: "Use the staging database instead.",
  ...overrides,
});

/** The turn runtime as steering sees it: a running turn, a provider answer, and the transcript save. */
class FakeTurnRuntime implements TurnSteerRuntime {
  running: { turnExecutionId: string; steerable: boolean } | null = { turnExecutionId: EXECUTION, steerable: true };
  respond: (input: TurnSteerMessage) => Promise<TurnSteerOutcome> = async () => ({ outcome: "accepted" });
  saveFails = false;
  readonly sent: TurnSteerMessage[] = [];
  readonly saved: AcceptedSteerMessage[] = [];

  constructor(private readonly repo: TurnSteerRepo) {}

  runningTurn(threadId: string): SteerableTurn | null {
    if (threadId !== THREAD || !this.running) return null;
    return {
      turnExecutionId: this.running.turnExecutionId,
      steer: this.running.steerable ? (input) => { this.sent.push(input); return this.respond(input); } : null,
    };
  }

  async recordDelivered(message: AcceptedSteerMessage): Promise<void> {
    if (this.saveFails) throw new Error("transcript write failed");
    this.saved.push(message);
    await this.repo.markDelivered(message.messageId);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("durable Send now", () => {
  let directory: string;
  let dbPath: string;
  let db: Database;
  let writer: ApplicationDatabaseWriter;
  let repo: TurnSteerRepo;
  let runtime: FakeTurnRuntime;
  let service: TurnSteerService;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-turn-steer-"));
    dbPath = NodePath.join(directory, "app.sqlite");
    db = openDatabase({ dbPath });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace", "Workspace", directory, NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(THREAD, "workspace", "Thread", "main", "codex", NOW, NOW);
    writer = new ApplicationDatabaseWriter(dbPath);
    repo = new TurnSteerRepo(db, writer);
    runtime = new FakeTurnRuntime(repo);
    service = new TurnSteerService(repo, runtime);
  });

  afterEach(async () => {
    await writer.close();
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  /** A new process on the same database file: new writer, repo, runtime and service, then startup reconcile. */
  async function restart() {
    await writer.close();
    writer = new ApplicationDatabaseWriter(dbPath);
    repo = new TurnSteerRepo(db, writer);
    runtime = new FakeTurnRuntime(repo);
    service = new TurnSteerService(repo, runtime);
    return service.reconcileAtStartup();
  }

  async function steerUncertain() {
    runtime.respond = async () => ({ outcome: "unknown", detail: "socket closed" });
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "delivery_unknown", messageId: STEER_ID });
  }

  it("delivers once and answers a replay after a lost response without calling the provider again", async () => {
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "delivered", messageId: STEER_ID });
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "delivered", messageId: STEER_ID });

    expect(runtime.sent).toEqual([{ steerId: STEER_ID, message: "Use the staging database instead." }]);
    expect(runtime.saved).toEqual([{ threadId: THREAD, turnExecutionId: EXECUTION, messageId: STEER_ID,
      content: "Use the staging database instead." }]);
    expect(repo.find(STEER_ID)?.state).toBe("delivered");
    expect(service.listHeldSteers()).toEqual([]);
  });

  it("joins a duplicate that arrives while the provider call is in flight", async () => {
    const answer = deferred<TurnSteerOutcome>();
    runtime.respond = () => answer.promise;

    const first = service.steer(steerParams());
    const duplicate = service.steer(steerParams());
    await expect(service.steer(steerParams({ content: "Something else." }))).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    answer.resolve({ outcome: "accepted" });

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { status: "delivered", messageId: STEER_ID }, { status: "delivered", messageId: STEER_ID }]);
    expect(runtime.sent).toHaveLength(1);
  });

  it("refuses a settled id reused with different inputs", async () => {
    await service.steer(steerParams());

    await expect(service.steer(steerParams({ content: "Different text." })))
      .rejects.toMatchObject({ name: "TurnSteerConflictError", code: "INVALID_PARAMS" });
    await expect(service.steer(steerParams({ turnExecutionId: "execution-other" })))
      .rejects.toMatchObject({ name: "TurnSteerConflictError" });
    expect(runtime.sent).toHaveLength(1);
  });

  it("holds a steer the provider took when the server died before saving it, and never resends it", async () => {
    await expect(service.steer(steerParams(), { stopAt: "after-provider-accepted" })).rejects.toBeInstanceOf(TurnSteerFaultStop);
    expect(repo.find(STEER_ID)?.state).toBe("pending");

    await expect(restart()).resolves.toEqual({ unknown: 1, deleted: 0 });

    expect(service.listHeldSteers()).toEqual([{ messageId: STEER_ID, threadId: THREAD,
      content: "Use the staging database instead.", state: "delivery_unknown" }]);
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "delivery_unknown", messageId: STEER_ID });
    expect(runtime.sent).toEqual([]);
  });

  it("returns delivery_unknown when the provider gives no answer or the call throws", async () => {
    await steerUncertain();

    runtime.respond = async () => { throw new Error("connection reset"); };
    const other = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    await expect(service.steer(steerParams({ messageId: other }))).resolves.toEqual({ status: "delivery_unknown", messageId: other });

    expect(service.listHeldSteers().map((held) => [held.messageId, held.state])).toEqual([
      [STEER_ID, "delivery_unknown"], [other, "delivery_unknown"]]);
  });

  it("holds a steer whose transcript save failed, and a late save still marks it delivered", async () => {
    runtime.saveFails = true;
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "delivery_unknown", messageId: STEER_ID });

    await expect(repo.markDelivered(STEER_ID)).resolves.toBe(true);
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "delivered", messageId: STEER_ID });
    expect(service.listHeldSteers()).toEqual([]);
  });

  it("stores a provider refusal and rethrows it on replay, so nothing is held", async () => {
    runtime.respond = async () => ({ outcome: "rejected", reason: "turn_not_running", detail: "turn finished" });
    await expect(service.steer(steerParams())).rejects.toMatchObject({ name: "TurnSteerError", code: "turn_not_running" });
    await expect(service.steer(steerParams())).rejects.toMatchObject({ name: "TurnSteerError", code: "turn_not_running" });

    const refused = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    runtime.respond = async () => ({ outcome: "rejected", reason: "provider", detail: "input too large" });
    await expect(service.steer(steerParams({ messageId: refused })))
      .rejects.toMatchObject({ code: "steer_rejected", detail: "input too large" });
    await expect(service.steer(steerParams({ messageId: refused })))
      .rejects.toMatchObject({ code: "steer_rejected", detail: "input too large" });

    expect(runtime.sent).toHaveLength(2);
    expect(service.listHeldSteers()).toEqual([]);
  });

  it("checks the running turn before storing anything", async () => {
    runtime.running = null;
    await expect(service.steer(steerParams())).rejects.toMatchObject({ code: "turn_not_running" });

    runtime.running = { turnExecutionId: "execution-next", steerable: true };
    await expect(service.steer(steerParams())).rejects.toMatchObject({ code: "turn_not_running" });

    runtime.running = { turnExecutionId: EXECUTION, steerable: false };
    await expect(service.steer(steerParams())).rejects.toMatchObject({ code: "steer_unsupported" });

    expect(repo.find(STEER_ID)).toBeNull();
    runtime.running = { turnExecutionId: EXECUTION, steerable: true };
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "delivered", messageId: STEER_ID });
  });

  it("removes an uncertain steer once across windows and replays", async () => {
    await steerUncertain();

    await expect(service.settleUnknownSteer({ messageId: STEER_ID, action: "remove" })).resolves.toEqual({ status: "removed" });
    await expect(service.settleUnknownSteer({ messageId: STEER_ID, action: "remove" })).resolves.toEqual({ status: "closed" });
    await expect(service.settleUnknownSteer({ messageId: STEER_ID, action: "send-again" })).resolves.toEqual({ status: "closed" });
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "closed", messageId: STEER_ID });
    expect(service.listHeldSteers()).toEqual([]);
    expect(runtime.sent).toHaveLength(1);
  });

  it("queues one resend under a fresh id that survives a restart and is admitted once", async () => {
    await steerUncertain();

    const queued = await service.settleUnknownSteer({ messageId: STEER_ID, action: "send-again" });
    if (queued.status !== "requeued") throw new Error(`expected requeued, got ${queued.status}`);
    const replacement = queued.replacementMessageId;
    expect(replacement).toMatch(UUID);
    expect(replacement).not.toBe(STEER_ID);
    await expect(service.settleUnknownSteer({ messageId: STEER_ID, action: "send-again" }))
      .resolves.toEqual({ status: "requeued", replacementMessageId: replacement });

    await expect(restart()).resolves.toEqual({ unknown: 0, deleted: 0 });
    expect(service.listHeldSteers()).toEqual([{ messageId: STEER_ID, threadId: THREAD,
      content: "Use the staging database instead.", state: "resend_queued", replacementMessageId: replacement }]);
    await expect(service.steer(steerParams())).resolves.toEqual({ status: "closed", messageId: STEER_ID });
    await expect(service.steer(steerParams({ messageId: replacement }))).rejects.toMatchObject({ code: "steer_unsupported" });

    // Turn admission runs this claim inside the transaction that starts the resend's turn.
    const admission = new TurnSteerStore(db);
    expect(admission.claimResend(STEER_ID, "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f")).toBe(false);
    expect(admission.claimResend(STEER_ID, replacement)).toBe(true);
    expect(admission.claimResend(STEER_ID, replacement)).toBe(false);

    expect(service.listHeldSteers()).toEqual([]);
    await expect(service.settleUnknownSteer({ messageId: STEER_ID, action: "send-again" })).resolves.toEqual({ status: "closed" });
    await expect(service.settleUnknownSteer({ messageId: STEER_ID, action: "remove" })).resolves.toEqual({ status: "closed" });
    await expect(service.steer(steerParams({ messageId: replacement }))).rejects.toMatchObject({ code: "steer_unsupported" });
    expect(runtime.sent).toEqual([]);
  });

  it("deletes settled steers past retention at startup and keeps held ones", async () => {
    await service.steer(steerParams());
    const held = "4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a";
    runtime.respond = async () => ({ outcome: "unknown", detail: "socket closed" });
    await service.steer(steerParams({ messageId: held }));
    db.prepare("UPDATE turn_steers SET updated_at = ?").run("2020-01-01T00:00:00.000Z");

    await expect(restart()).resolves.toEqual({ unknown: 0, deleted: 1 });
    expect(repo.find(STEER_ID)).toBeNull();
    expect(service.listHeldSteers().map((steer) => steer.messageId)).toEqual([held]);
  });
});
