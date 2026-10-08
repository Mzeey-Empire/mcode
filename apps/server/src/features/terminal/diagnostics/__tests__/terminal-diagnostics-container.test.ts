import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";
import { setupContainer } from "../../../../application/composition/container.js";
import { AgentService } from "../../../agents/index.js";
import { HandoffCheckoutService } from "../../../handoff/index.js";
import { GitWatcherService, WorkspaceService } from "../../../projects/index.js";
import { TERMINAL_BACKEND_TOKEN, type TerminalBackend } from "../../backends/terminal-backend.js";
import { PtyHostSupervisor } from "../../host/pty-host-supervisor.js";
import { TerminalDiagnosticsService } from "../terminal-diagnostics-service.js";

const LEGACY_CAPABILITIES = {
  contractVersion: 0,
  backend: "legacy",
  publicFrameVersion: 0,
  recovery: { replay: true, checkpoint: true, gap: true },
};

describe("Terminal diagnostics container wiring", () => {
  let database: Database | undefined;
  let temporaryDirectory: string | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(async () => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-terminal-diagnostics-"));
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    await setupContainer(temporaryDirectory);
    database = container.resolve<Database>("Database");

    const host = container.resolve<PtyHostSupervisor>("PtyHost");
    vi.spyOn(host, "health").mockReturnValue({ state: "healthy", hostGeneration: "7" });
    vi.spyOn(host, "diagnostics").mockReturnValue({
      lastHeartbeatMsAgo: 11, queueBytes: 43, eventLoopLagMs: 5, hostRssBytes: "2048",
    });
  });

  afterEach(async () => {
    if (!database && container.isRegistered("Database")) {
      database = container.resolve<Database>("Database");
    }
    if (container.isRegistered(ApplicationDatabaseWriter)) {
      await container.resolve(ApplicationDatabaseWriter).close();
    }
    database?.close(true);
    database = undefined;
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (temporaryDirectory) NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("routes host health measurements through diagnostics RPC", async () => {
    const diagnostics = container.resolve(TerminalDiagnosticsService);
    const response = await routeMessage(JSON.stringify({
      id: "legacy_bundle",
      method: "terminal.diagnostics.getBundle",
      params: {},
    }), { terminalDiagnosticsService: diagnostics } as unknown as RouterDeps);

    expect(response).toMatchObject({
      id: "legacy_bundle",
      result: {
        backend: "legacy",
        health: {
          lastHeartbeatMsAgo: 11,
          queueBytes: 43,
          eventLoopLagMs: 5,
          hostRssBytes: "2048",
        },
      },
    });
    expect(container.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN).capabilities()).toEqual(
      LEGACY_CAPABILITIES,
    );
  });

  it("resolves workspace, agent, Git watcher, and Handoff lifecycles through the configured container", () => {
    expect(container.resolve(WorkspaceService)).toBeInstanceOf(WorkspaceService);
    expect(container.resolve(AgentService)).toBeInstanceOf(AgentService);
    expect(container.resolve(GitWatcherService)).toBeInstanceOf(GitWatcherService);
    expect(container.resolve(HandoffCheckoutService)).toBeInstanceOf(HandoffCheckoutService);
  });

  it("caps legacy active sessions at the diagnostics schema limit", async () => {
    container.register<TerminalBackend>(TERMINAL_BACKEND_TOKEN, {
      useValue: {
        capabilities: () => ({
          contractVersion: 0,
          backend: "legacy",
          publicFrameVersion: 0,
          recovery: { replay: true, checkpoint: true, gap: true },
        }),
        listActiveSessions: () => Array.from(
          { length: 25 },
          (_, index) => ({ ptyId: `pty-${index}`, threadId: "thread" }),
        ),
      } as unknown as TerminalBackend,
    });

    const diagnostics = container.resolve(TerminalDiagnosticsService);
    const response = await routeMessage(JSON.stringify({
      id: "legacy_bundle",
      method: "terminal.diagnostics.getBundle",
      params: {},
    }), { terminalDiagnosticsService: diagnostics } as unknown as RouterDeps);

    expect(response).toMatchObject({
      id: "legacy_bundle",
      result: { backend: "legacy", health: { activeSessions: 20 } },
    });
  });
});
