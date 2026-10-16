import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import type { WorkspaceEnvironmentActionRun, WorkspaceEnvironmentActionSlotInput } from "@mcode/contracts";
import { WorkspaceEnvironmentService, type WorkspaceEnvironmentServiceOptions } from "../workspace-environment-service.js";
import type { StartupProjectActions } from "../startup-action-runner.js";
import type { PreparedTerminalCommand, TerminalCommandCompletion } from "../../../terminal/commands/terminal-command-service.js";

/** Compose a real startup gate with a fake action boundary for provider/admission tests. */
export function startupEnvironmentFixture(options: WorkspaceEnvironmentServiceOptions): WorkspaceEnvironmentService {
  const actions = new FixtureActions();
  const environment = new WorkspaceEnvironmentService({ ...options, projectActions: () => actions });
  actions.resolve = (input) => environment.resolveActionCommand(input.threadId, input.actionId);
  return environment;
}

class FixtureActions implements StartupProjectActions {
  resolve: (input: WorkspaceEnvironmentActionSlotInput) => ReturnType<WorkspaceEnvironmentService["resolveActionCommand"]>
    = async () => { throw new Error("Fixture not composed"); };
  private readonly runs = new Map<string, WorkspaceEnvironmentActionRun>();
  private readonly commands = new Map<string, PreparedTerminalCommand>();
  private readonly listeners = new Set<Parameters<StartupProjectActions["onUpdate"]>[0]>();

  get(input: WorkspaceEnvironmentActionSlotInput) { return this.runs.get(key(input)) ?? null; }
  onUpdate(listener: Parameters<StartupProjectActions["onUpdate"]>[0]) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onCommandOutput() { return () => undefined; }

  async start(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun> {
    const resolved = await this.resolve(input);
    const timestamp = new Date().toISOString();
    const run: WorkspaceEnvironmentActionRun = {
      ...input, workspaceId: "fixture", actionName: input.actionId,
      runId: NodeCrypto.randomUUID(), revision: 1, trigger: "startup", port: null,
      terminalSessionId: key(input), snapshot: resolved.snapshot,
      status: resolved.kind === "ready" ? "running" : "failed",
      createdAt: timestamp, startedAt: timestamp, finishedAt: resolved.kind === "ready" ? null : timestamp, exitCode: null,
    };
    this.publish(run);
    if (resolved.kind === "ready") {
      this.commands.set(key(input), resolved.command);
      void resolved.command.start().then((result) => this.finish(run, result));
    }
    return run;
  }

  async restart(input: WorkspaceEnvironmentActionSlotInput) { return this.start(input); }

  async stop(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun | null> {
    const command = this.commands.get(key(input));
    const result = await command?.close();
    if (result?.kind === "containment_failure") throw new Error("Fixture command containment failed");
    const run = this.get(input);
    if (!run) return null;
    const interrupted: WorkspaceEnvironmentActionRun = {
      ...run, revision: run.revision + 1, status: "interrupted", finishedAt: new Date().toISOString(),
    };
    this.publish(interrupted);
    return interrupted;
  }

  private finish(run: WorkspaceEnvironmentActionRun, result: TerminalCommandCompletion): void {
    const current = this.get(run);
    if (current?.runId !== run.runId || current.status !== "running") return;
    const exitCode = result.kind === "exited" ? result.exitCode : null;
    this.publish({
      ...run, revision: run.revision + 1, exitCode, status: exitCode === 0 ? "completed" : "failed",
      finishedAt: new Date().toISOString(),
    });
  }

  private publish(run: WorkspaceEnvironmentActionRun): void {
    this.runs.set(key(run), run);
    for (const listener of this.listeners) listener({ threadId: run.threadId, actionId: run.actionId, runId: run.runId, run });
  }
}

function key(input: WorkspaceEnvironmentActionSlotInput): string {
  return `${input.threadId}:${input.actionId}`;
}
