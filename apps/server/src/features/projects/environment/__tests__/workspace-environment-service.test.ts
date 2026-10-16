import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceEnvironmentService,
  WorkspaceEnvironmentServiceError,
} from "../workspace-environment-service.js";
import { WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES } from "@mcode/contracts";

const workspaceId = "workspace-1";
const document = {
  version: "0.0.1" as const,
  actions: [{ id: "action-1", name: "Run app", command: { default: "bun run dev" } }],
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
});

async function service(): Promise<{ root: string; instance: WorkspaceEnvironmentService }> {
  const fixture = NodePath.resolve("../..", ".dev/fixture-repo");
  await NodeFSPromises.mkdir(fixture, { recursive: true });
  const root = await NodeFSPromises.mkdtemp(NodePath.join(fixture, "mcode-environment-"));
  roots.push(root);
  return { root, instance: new WorkspaceEnvironmentService(root) };
}

function sharedEnvironmentThread(
  id: string,
  baseCheckout: string,
  worktreeCheckout: string,
) {
  if (id === "direct") return { id, workspace_id: workspaceId, mode: "direct" };
  if (id === "worktree") {
    return {
      id,
      workspace_id: workspaceId,
      mode: "worktree",
      worktree_managed: false,
      worktree_path: worktreeCheckout,
    };
  }
  return null;
}

function requireTestValue<T>(value: T | null | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

describe("WorkspaceEnvironmentService", () => {
  it.each(["0.0.1", "0.1.0"])("discovers and round-trips a shared %s document", async (version) => {
    const { root } = await service();
    const path = NodePath.join(root, ".mcode", "environment.json");
    await NodeFSPromises.mkdir(NodePath.dirname(path), { recursive: true });
    const original = { ...document, version, actions: [{ ...document.actions[0], futureAction: { enabled: true } }] };
    await NodeFSPromises.writeFile(path, JSON.stringify(original));
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: NodePath.join(root, "system"),
      workspaces: { findById: (id) => id === workspaceId ? { id, path: root } : null },
    });
    const read = await instance.read(workspaceId);
    expect(read.storageMode).toBe("shared");
    expect(read.document).toEqual(original);
    const saved = await instance.save({ workspaceId, sourceRevision: read.revision, document: read.document });
    expect(saved.document).toEqual({ ...original, version: "0.1.0" });
    expect(JSON.parse(await NodeFSPromises.readFile(path, "utf8"))).toEqual({ ...original, version: "0.1.0" });
    expect(await instance.read(workspaceId)).toEqual(saved);
  });

  it("upgrades a system legacy file in memory and writes the action only on Save", async () => {
    const { root, instance } = await service();
    const path = NodePath.join(root, "projects", workspaceId, "environment.json");
    await NodeFSPromises.mkdir(NodePath.dirname(path), { recursive: true });
    const original = {
      version: "0.0.1",
      setup: { default: "bun install", windows: "bun install --frozen-lockfile" },
      actions: [{ id: "run", name: "Run", command: { default: "bun run dev", linux: "./dev.sh" } }],
    };
    await NodeFSPromises.writeFile(path, JSON.stringify(original, null, 2));
    const read = await instance.read(workspaceId);
    const upgraded = { version: "0.1.0", actions: [{ id: "setup", name: "setup", command: original.setup, runOnStartup: true }, ...original.actions] };
    expect(read.document).toEqual(upgraded);
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe(JSON.stringify(original, null, 2));
    const saved = await instance.save({ workspaceId, sourceRevision: read.revision, document: read.document });
    expect(saved.document).toEqual(upgraded);
    expect(JSON.parse(await NodeFSPromises.readFile(path, "utf8"))).toEqual(upgraded);
    expect(await instance.read(workspaceId)).toEqual(saved);
  });

  it("promotes a legacy file to 0.1.0 for startup and downgrades again when the field is removed", async () => {
    const { root, instance } = await service();
    const first = await instance.save({ workspaceId, sourceRevision: null, document });
    const read = await instance.read(workspaceId);
    const withStartup = { ...read.document, actions: read.document.actions.map((action) => ({ ...action, runOnStartup: true })) };
    const saved = await instance.save({ workspaceId, sourceRevision: read.revision, document: withStartup });
    const expected = { version: "0.1.0", actions: [{ id: "action-1", name: "Run app", command: { default: "bun run dev" }, runOnStartup: true }] };
    expect(saved.document).toEqual(expected);
    expect(saved.revision).not.toBe(first.revision);
    const path = NodePath.join(root, "projects", workspaceId, "environment.json");
    expect(JSON.parse(await NodeFSPromises.readFile(path, "utf8"))).toEqual(expected);
    expect(await instance.read(workspaceId)).toEqual(saved);
    const downgraded = await instance.save({ workspaceId, sourceRevision: saved.revision, document: { ...document, version: "0.1.0" } });
    expect(downgraded.document).toEqual(document);
    expect(JSON.parse(await NodeFSPromises.readFile(path, "utf8"))).toEqual(document);
    expect(await instance.read(workspaceId)).toEqual(downgraded);
  });

  it("preserves unknown top-level and action keys from a 0.1.0 file on save", async () => {
    const { root, instance } = await service();
    const path = NodePath.join(root, "projects", workspaceId, "environment.json");
    await NodeFSPromises.mkdir(NodePath.dirname(path), { recursive: true });
    const original = {
      version: "0.1.0",
      futureDocument: { order: ["run"] },
      actions: [{ id: "run", name: "Run", command: { default: "bun run dev" }, futureAction: [1, "two"] }],
    };
    await NodeFSPromises.writeFile(path, JSON.stringify(original));
    const read = await instance.read(workspaceId);
    expect(read.document).toEqual(original);
    const saved = await instance.save({ workspaceId, sourceRevision: read.revision, document: read.document });
    expect(saved.document).toEqual(original);
    expect(JSON.parse(await NodeFSPromises.readFile(path, "utf8"))).toEqual(original);
    expect(await instance.read(workspaceId)).toEqual(saved);
  });

  it("rejects a 0.2.0 file on read and save without changing its bytes", async () => {
    const { root, instance } = await service();
    const path = NodePath.join(root, "projects", workspaceId, "environment.json");
    await NodeFSPromises.mkdir(NodePath.dirname(path), { recursive: true });
    const bytes = '{"version":"0.2.0","actions":[]}';
    await NodeFSPromises.writeFile(path, bytes);
    const expectedError = {
      code: "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION",
      issues: [expect.objectContaining({ path: ["version"], reason: "unsupported_version" })],
    };
    await expect(instance.read(workspaceId)).rejects.toMatchObject(expectedError);
    await expect(instance.save({ workspaceId, sourceRevision: null, document })).rejects.toMatchObject(expectedError);
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe(bytes);
  });

  it("rejects saving a retired setup field without changing existing bytes", async () => {
    const { instance } = await service();
    const saved = await instance.save({ workspaceId, sourceRevision: null, document });
    await expect(instance.save({
      workspaceId, sourceRevision: saved.revision, document: { ...document, setup: { default: "bun install" } },
    })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_VALIDATION" });
    expect(await instance.read(workspaceId)).toEqual(saved);
  });

  it("reads an absent default and saves at projects/<workspace-id>/environment.json", async () => {
    const { root, instance } = await service();
    const absent = await instance.read(workspaceId);
    expect(absent).toEqual({ document: { version: "0.0.1", actions: [] }, revision: null, status: "absent", storageMode: "system" });
    const saved = await instance.save({ workspaceId, sourceRevision: absent.revision, document });
    expect(saved.document).toEqual(document);
    expect(saved.revision).toBeTruthy();
    expect(await NodeFSPromises.readFile(NodePath.join(root, "projects", workspaceId, "environment.json"), "utf8")).toContain('"version":"0.0.1"');
  });

  it("saves an untouched default as 0.0.1", async () => {
    const { root, instance } = await service();
    const absent = await instance.read(workspaceId);
    const saved = await instance.save({ workspaceId, sourceRevision: absent.revision, document: absent.document });
    expect(saved.document).toEqual({ version: "0.0.1", actions: [] });
    expect(await NodeFSPromises.readFile(NodePath.join(root, "projects", workspaceId, "environment.json"), "utf8"))
      .toBe('{"version":"0.0.1","actions":[]}');
    expect(await instance.read(workspaceId)).toEqual(saved);
  });

  it("replaces atomically and rejects stale saves without changing newer bytes", async () => {
    const { root, instance } = await service();
    const first = await instance.save({ workspaceId, sourceRevision: null, document });
    const newer = await instance.save({ workspaceId, sourceRevision: first.revision, document: { ...document, actions: [] } });
    const path = NodePath.join(root, "projects", workspaceId, "environment.json");
    const before = await NodeFSPromises.readFile(path, "utf8");
    await expect(instance.save({ workspaceId, sourceRevision: first.revision, document })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_STALE" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe(before);
    expect(newer.revision).not.toBe(first.revision);
    expect((await NodeFSPromises.readdir(NodePath.join(root, "projects", workspaceId))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent saves so exactly one wins a shared revision", async () => {
    const { root, instance } = await service();
    const firstDocument = { ...document, actions: [{ ...document.actions[0], name: "First" }] };
    const secondDocument = { ...document, actions: [{ ...document.actions[0], name: "Second" }] };
    const saves = await Promise.allSettled([
      instance.save({ workspaceId, sourceRevision: null, document: firstDocument }),
      instance.save({ workspaceId, sourceRevision: null, document: secondDocument }),
    ]);
    const successes = saves.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<WorkspaceEnvironmentService["save"]>>> => result.status === "fulfilled");
    const stale = saves.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toMatchObject({ code: "WORKSPACE_ENVIRONMENT_STALE" });
    const persisted = await instance.read(workspaceId);
    expect(persisted.document).toEqual(successes[0]?.value.document);
    expect(await NodeFSPromises.readFile(NodePath.join(root, "projects", workspaceId, "environment.json"), "utf8")).toContain(persisted.document.actions[0]?.name);
  });

  it("reads and writes the selected worktree checkout without accepting a revision from another storage scope", async () => {
    const { root } = await service();
    const baseCheckout = NodePath.join(root, "base");
    const worktreeCheckout = NodePath.join(root, "worktree");
    await NodeFSPromises.mkdir(worktreeCheckout, { recursive: true });
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      platform: "linux",
      workspaces: { findById: (id) => id === workspaceId ? { id, path: baseCheckout } : null },
      threads: {
        findById: (id) => id === "worktree"
          ? { id, workspace_id: workspaceId, mode: "worktree", worktree_path: worktreeCheckout }
          : null,
      },
    });

    await instance.setStorageMode({ workspaceId, threadId: "worktree", storageMode: "shared" });
    const worktreeRead = await instance.read(workspaceId, "worktree");
    const worktreeSaved = await instance.save({
      workspaceId,
      threadId: "worktree",
      sourceRevision: worktreeRead.revision,
      document,
    });
    const baseSaved = await instance.save({ workspaceId, sourceRevision: null, document });

    expect(await NodeFSPromises.readFile(NodePath.join(worktreeCheckout, ".mcode", "environment.json"), "utf8")).toContain('"bun run dev"');
    await expect(instance.save({
      workspaceId,
      threadId: "worktree",
      sourceRevision: baseSaved.revision,
      document: { ...document, actions: [] },
    })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_STALE" });
    expect(worktreeSaved.revision).not.toBe(baseSaved.revision);
  });

  it("requires approval for the upgraded shared action and never falls back from a worktree checkout", async () => {
    const { root } = await service();
    const baseCheckout = NodePath.join(root, "base");
    const worktreeCheckout = NodePath.join(root, "worktree");
    await NodeFSPromises.mkdir(NodePath.join(baseCheckout, ".mcode"), { recursive: true });
    await NodeFSPromises.mkdir(worktreeCheckout, { recursive: true });
    await NodeFSPromises.writeFile(NodePath.join(baseCheckout, ".mcode", "environment.json"), JSON.stringify({
      version: "0.0.1",
      setup: { default: "bun run setup" },
      actions: [{ id: "build", name: "Build", command: { default: "bun run build" } }],
    }));
    const start = vi.fn(async () => ({ kind: "exited" as const, exitCode: 0, output: "ready", outputTruncated: false }));
    const close = vi.fn(async () => ({ kind: "contained" as const }));
    const prepare = vi.fn(async () => ({
      kind: "ready" as const,
      command: {
        snapshot: {
          checkoutPath: baseCheckout,
          terminal: { executable: "pwsh.exe", arguments: ["-Command", "bun run setup"] },
        },
        start,
        close,
        waitForRelease: async () => undefined,
      },
    }));
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      platform: "linux",
      workspaces: { findById: (id) => id === workspaceId ? { id, path: baseCheckout } : null },
      threads: { findById: (id) => sharedEnvironmentThread(id, baseCheckout, worktreeCheckout) },
      terminalCommands: { prepare },
    });

    expect((await instance.read(workspaceId)).storageMode).toBe("shared");
    const pending = await instance.resolveActionCommand("direct", "setup");
    expect(pending.kind).toBe("ready");
    expect(pending.snapshot.script).toBe("bun run setup");
    expect(start).not.toHaveBeenCalled();
    const approval = requireTestValue(pending.snapshot.approval, "Expected a shared command approval");

    await expect(instance.approveCommand({ ...approval, threadId: "direct", fingerprint: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_APPROVAL_STALE" });
    await instance.approveCommand({ ...approval, threadId: "direct" });
    const approvedSetup = await instance.resolveActionCommand("direct", "setup");
    expect(approvedSetup.kind === "ready" && approvedSetup.approval).toBeNull();
    await closeReadyCommand(approvedSetup);
    expect(start).not.toHaveBeenCalled();

    const actionResolution = await instance.resolveActionCommand("direct", "build");
    expect(actionResolution.kind).toBe("ready");
    if (actionResolution.kind !== "ready" || !actionResolution.approval) throw new Error("Expected Action approval");
    await instance.approveCommand({ threadId: "direct", ...actionResolution.approval });
    const approvedAction = await instance.resolveActionCommand("direct", "build");
    expect(approvedAction.kind === "ready" && approvedAction.approval).toBeNull();
    await closeReadyCommand(approvedAction);
    instance.clearApprovals(workspaceId);
    const clearedAction = await instance.resolveActionCommand("direct", "build");
    expect(clearedAction.kind === "ready" && clearedAction.approval?.target).toEqual({ kind: "action", actionId: "build" });
    await closeReadyCommand(clearedAction);

    await expect(instance.resolveActionCommand("worktree", "setup")).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND" });

    await NodeFSPromises.writeFile(NodePath.join(baseCheckout, ".mcode", "environment.json"), JSON.stringify({
      version: "0.0.1",
      setup: { default: "echo first\r\necho second" },
      actions: [],
    }));
    const crlfFingerprint = (await instance.resolveActionCommand("direct", "setup")).snapshot.approval?.fingerprint;
    await NodeFSPromises.writeFile(NodePath.join(baseCheckout, ".mcode", "environment.json"), JSON.stringify({
      version: "0.0.1",
      setup: { default: "echo first\necho second" },
      actions: [],
    }));
    const lfFingerprint = (await instance.resolveActionCommand("direct", "setup")).snapshot.approval?.fingerprint;
    expect(lfFingerprint).toBe(crlfFingerprint);
    expect(approval.target).toEqual({ kind: "action", actionId: "setup" });
  });

  it("rejects oversized persisted bytes before parsing and preserves the file", async () => {
    const { root, instance } = await service();
    const path = NodePath.join(root, "projects", workspaceId, "environment.json");
    await NodeFSPromises.mkdir(NodePath.join(root, "projects", workspaceId), { recursive: true });
    const oversized = `${JSON.stringify({ version: "0.0.1", actions: [] })}${" ".repeat(512 * 1024)}`;
    await NodeFSPromises.writeFile(path, oversized);
    await expect(instance.read(workspaceId)).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_VALIDATION",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DOCUMENT_TOO_LARGE", reason: "document_too_large" }),
      ]),
    });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe(oversized);
  });

  it("persists near-limit documents canonically within the raw byte bound", async () => {
    const { root, instance } = await service();
    const nearLimit = {
      version: "0.0.1" as const,
      actions: Array.from({ length: 256 }, (_, index) => ({
        id: `${index}${"i".repeat(40 - String(index).length)}`,
        name: "n".repeat(150),
        command: { default: "x".repeat(1780) },
      })),
    };
    const encoder = new TextEncoder();
    expect(encoder.encode(JSON.stringify(nearLimit)).byteLength).toBeLessThanOrEqual(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);
    expect(encoder.encode(`${JSON.stringify(nearLimit, null, 2)}\n`).byteLength).toBeGreaterThan(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);

    const saved = await instance.save({ workspaceId, sourceRevision: null, document: nearLimit });
    const path = NodePath.join(root, "projects", workspaceId, "environment.json");
    const raw = await NodeFSPromises.readFile(path);
    expect(raw.byteLength).toBeLessThanOrEqual(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);
    expect((await instance.read(workspaceId)).document).toEqual(saved.document);
  });

  it("keeps existing bytes when validation or unsupported-version checks fail", async () => {
    const { root, instance } = await service();
    const saved = await instance.save({ workspaceId, sourceRevision: null, document });
    const path = NodePath.join(root, "projects", workspaceId, "environment.json");
    const before = await NodeFSPromises.readFile(path, "utf8");
    await expect(instance.save({ workspaceId, sourceRevision: saved.revision, document: { ...document, setup: {} } })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_VALIDATION" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toBe(before);

    await NodeFSPromises.writeFile(path, JSON.stringify({ ...document, version: "9.9.9" }));
    await expect(instance.read(workspaceId)).rejects.toBeInstanceOf(WorkspaceEnvironmentServiceError);
    await expect(instance.save({ workspaceId, sourceRevision: saved.revision, document })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION" });
    expect(await NodeFSPromises.readFile(path, "utf8")).toContain('"version":"9.9.9"');
  });

});
async function closeReadyCommand(resolution: Awaited<ReturnType<WorkspaceEnvironmentService["resolveActionCommand"]>>): Promise<void> {
  if (resolution.kind === "ready") await resolution.command.close();
}
