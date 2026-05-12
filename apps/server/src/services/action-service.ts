/**
 * Project action management service.
 * Reads, writes, and runs workspace actions stored as JSON on disk.
 * Follows the SettingsService pattern: file-based storage with in-memory cache,
 * atomic writes (temp + rename), and push broadcasts on change.
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { injectable, inject } from "tsyringe";
import { type Action, type ActionsFile, ActionsFileSchema } from "@mcode/contracts";
import { getMcodeDir, logger } from "@mcode/shared";
import { broadcast } from "../transport/push";
import type { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { TerminalService } from "./terminal-service.js";

/** Resolves the actions JSON file path for a workspace. */
function actionsFilePath(workspaceId: string): string {
  return join(getMcodeDir(), "workspaces", workspaceId, "actions.json");
}

/** Resolves the workspace-scoped data directory. */
function workspaceDataDir(workspaceId: string): string {
  return join(getMcodeDir(), "workspaces", workspaceId);
}

/**
 * Manages project actions for workspaces.
 * Actions are stored in per-workspace JSON files and cached in memory.
 */
@injectable()
export class ActionService {
  private cache = new Map<string, Action[]>();

  constructor(
    @inject("WorkspaceRepo") private readonly workspaceRepo: WorkspaceRepo,
    @inject(TerminalService) private readonly terminalService: TerminalService,
  ) {}

  /** Read actions for a workspace. Returns [] if file missing or invalid. */
  list(workspaceId: string): Action[] {
    const cached = this.cache.get(workspaceId);
    if (cached) return cached;

    const filePath = actionsFilePath(workspaceId);
    if (!existsSync(filePath)) {
      this.cache.set(workspaceId, []);
      return [];
    }

    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const parsed = ActionsFileSchema().safeParse(raw);
      if (!parsed.success) {
        logger.warn("Invalid actions file, returning empty", {
          workspaceId,
          error: parsed.error.message,
        });
        this.cache.set(workspaceId, []);
        return [];
      }
      this.cache.set(workspaceId, parsed.data.actions);
      return parsed.data.actions;
    } catch (err) {
      logger.warn("Failed to read actions file", { workspaceId, err });
      this.cache.set(workspaceId, []);
      return [];
    }
  }

  /**
   * Upsert an action. Enforces that at most one action has setup=true.
   * Returns the saved action.
   */
  save(workspaceId: string, action: Action): Action {
    const actions = [...this.list(workspaceId)];
    const idx = actions.findIndex((a) => a.id === action.id);

    // Clear setup flag on all other actions when setting a new setup action.
    if (action.setup) {
      for (const a of actions) {
        if (a.id !== action.id) a.setup = false;
      }
    }

    if (idx >= 0) {
      actions[idx] = action;
    } else {
      actions.push(action);
    }

    this.writeFile(workspaceId, actions);
    return action;
  }

  /** Delete an action by ID. Returns true if found and removed. */
  delete(workspaceId: string, actionId: string): boolean {
    const actions = this.list(workspaceId);
    const filtered = actions.filter((a) => a.id !== actionId);
    if (filtered.length === actions.length) return false;
    this.writeFile(workspaceId, filtered);
    return true;
  }

  /**
   * Reorder actions by ID list.
   * Any actions not in orderedIds are appended after the reordered set.
   */
  reorder(workspaceId: string, orderedIds: string[]): boolean {
    const actions = this.list(workspaceId);
    const map = new Map(actions.map((a) => [a.id, a]));
    const reordered: Action[] = [];
    for (const id of orderedIds) {
      const action = map.get(id);
      if (action) reordered.push(action);
    }
    // Append any actions not in the ordered list so nothing is lost.
    for (const action of actions) {
      if (!orderedIds.includes(action.id)) reordered.push(action);
    }
    this.writeFile(workspaceId, reordered);
    return true;
  }

  /**
   * Run an action by writing its command to the thread's terminal.
   * Reuses the first existing terminal for the thread, or creates a new one.
   */
  async run(workspaceId: string, actionId: string, threadId: string): Promise<void> {
    const actions = this.list(workspaceId);
    const action = actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`Action '${actionId}' not found`);

    // Find or create terminal for the thread.
    const sessions = this.terminalService.listByThread(threadId);
    let ptyId: string;
    if (sessions.length > 0) {
      ptyId = sessions[0]!.ptyId;
    } else {
      ptyId = this.terminalService.create(threadId);
    }

    // Write command with trailing newline to execute immediately.
    this.terminalService.write(ptyId, action.command + "\n");

    // Track the last-used action so the UI can highlight it.
    this.workspaceRepo.updateLastActionId(workspaceId, actionId);

    broadcast("action.ran", { workspaceId, actionId });
  }

  /**
   * Run the setup action for a workspace (if one is defined).
   * Called automatically after worktree creation. Fire-and-forget.
   */
  async runSetupAction(workspaceId: string, threadId: string): Promise<void> {
    const actions = this.list(workspaceId);
    const setup = actions.find((a) => a.setup);
    if (!setup) return;

    try {
      await this.run(workspaceId, setup.id, threadId);
    } catch (err) {
      logger.warn("Setup action failed", { workspaceId, actionId: setup.id, err });
    }
  }

  /** Remove the workspace data directory. Called during workspace deletion. */
  async removeDataDir(workspaceId: string): Promise<void> {
    this.cache.delete(workspaceId);
    const dir = workspaceDataDir(workspaceId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Clear caches on server shutdown. */
  dispose(): void {
    this.cache.clear();
  }

  private writeFile(workspaceId: string, actions: Action[]): void {
    const filePath = actionsFilePath(workspaceId);
    const dir = workspaceDataDir(workspaceId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data: ActionsFile = { actions };
    const json = JSON.stringify(data, null, 2);
    const tmpPath = filePath + ".tmp";

    writeFileSync(tmpPath, json, "utf-8");
    renameSync(tmpPath, filePath);

    this.cache.set(workspaceId, actions);
    broadcast("action.changed", { workspaceId });
  }
}
