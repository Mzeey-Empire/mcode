import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import { WorkspaceStore } from "../../../projects/persistence/workspace-store.js";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceTerminalPreferencesStore } from "../workspace-terminal-preferences-store.js";

describe("WorkspaceTerminalPreferencesStore", () => {
  let db: Database;
  let workspaces: WorkspaceStore;
  let service: WorkspaceTerminalPreferencesStore;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaces = new WorkspaceStore(db);
    service = new WorkspaceTerminalPreferencesStore(db);
  });

  afterEach(() => db.close());

  it("distinguishes inheritance from an explicit Automatic override", () => {
    const workspace = workspaces.create("One", "C:/one");

    expect(service.get(workspace.id)).toBeNull();
    expect(service.update(workspace.id, "automatic")).toMatchObject({
      workspaceId: workspace.id,
      defaultProfileId: "automatic",
    });
    expect(service.get(workspace.id)?.defaultProfileId).toBe("automatic");
  });

  it("survives rename, resets by deletion, and cascades on workspace deletion", () => {
    const workspace = workspaces.create("Before", "C:/before");
    service.update(workspace.id, "certified:windows-powershell-7");

    workspaces.rename(workspace.id, "After");
    expect(service.get(workspace.id)?.defaultProfileId).toBe("certified:windows-powershell-7");

    expect(service.reset(workspace.id)).toBe(true);
    expect(service.get(workspace.id)).toBeNull();

    service.update(workspace.id, "automatic");
    workspaces.hardDelete(workspace.id);
    expect(db.prepare(
      "SELECT workspace_id FROM workspace_terminal_preferences WHERE workspace_id = ?",
    ).get(workspace.id)).toBeNull();
  });

  it("rejects missing workspaces and invalid profile references", () => {
    expect(() => service.update(
      "11111111-1111-4111-8111-111111111111",
      "automatic",
    )).toThrow(/workspace/i);
    const workspace = workspaces.create("One", "C:/one");
    expect(() => service.update(workspace.id, "missing" as "automatic")).toThrow();
  });
});
