import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { container } from "tsyringe";
// Load the container first, matching server startup order, so feature module cycles resolve as they do in production.
import { setupContainer } from "../container.js";
import { WorkerOwnedTurnRuntime } from "../../../features/agents/execution/worker-owned-turn-runtime.js";
import { ApprovalService } from "../../../features/agents/approvals/approval-service.js";
import { ThreadControlService } from "../../../features/thread-control/authority/thread-control-service.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";

describe("server container approval composition", () => {
  let database: Database | undefined;
  let workerRuntime: WorkerOwnedTurnRuntime | undefined;
  let temporaryDirectory: string | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(async () => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-container-approval-"));
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    await setupContainer(temporaryDirectory);
    database = container.resolve<Database>("Database");
    workerRuntime = container.resolve(WorkerOwnedTurnRuntime);
    await workerRuntime.whenReady();
  });

  afterEach(async () => {
    await workerRuntime?.close();
    workerRuntime = undefined;
    if (container.isRegistered(ApplicationDatabaseWriter)) await container.resolve(ApplicationDatabaseWriter).close();
    database?.close(true);
    database = undefined;
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (temporaryDirectory) NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("resolves thread control and the provider registry behind one approval service", () => {
    const threadControl = container.resolve(ThreadControlService);
    const approvals = container.resolve(ApprovalService);

    expect(threadControl).toBeInstanceOf(ThreadControlService);
    expect(container.resolve(ApprovalService)).toBe(approvals);
  });
});
