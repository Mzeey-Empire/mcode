import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_METHODS } from "@mcode/contracts";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../testing/owned-test-database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { FakeGitExecutor } from "../../git/execution/index.js";
import { WorkspaceService } from "../workspace-service.js";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof NodeOS>();
  return { ...original, homedir: vi.fn(original.homedir) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFSPromises>();
  return { ...original, access: vi.fn(original.access), stat: vi.fn(original.stat) };
});

describe("WorkspaceService.create", () => {
  let directory: string;
  let home: string;
  let project: string;
  let owned: OwnedTestDatabase;
  let reader: Database;
  let repo: WorkspaceRepo;
  let threads: ThreadRepo;
  let service: WorkspaceService;

  beforeEach(async () => {
    directory = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workspace-create-"));
    directory = await NodeFSPromises.realpath(directory);
    home = NodePath.join(directory, "home");
    project = NodePath.join(home, "project");
    await NodeFSPromises.mkdir(project, { recursive: true });
    vi.mocked(NodeOS.homedir).mockReturnValue(home);
    owned = createOwnedTestDatabase();
    reader = openReadOnlyDatabase(owned.db.filename);
    repo = new WorkspaceRepo(reader, owned.writer);
    threads = new ThreadRepo(reader, owned.writer);
    service = new WorkspaceService(repo, threads, owned.writer,
      { removeForThread: vi.fn() },
      {
        teardownThread: vi.fn(async () => undefined),
        deletePersistentData: async <Result>(_ids: readonly string[], remove: () => Promise<Result>) => remove(),
      },
      new FakeGitExecutor(),
      { killByThread: vi.fn(async () => undefined) },
    );
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await owned.writer.barrier();
    reader.close(true);
    await owned.close();
    await NodeFSPromises.rm(directory, { recursive: true, force: true });
  });

  it("registers a real folder and derives its name when omitted", async () => {
    const result = await service.create(undefined, project);
    expect(result).toMatchObject({ ok: true, reused: false, workspace: { name: "project", path: project } });
    if (!result.ok) throw new Error("Expected successful registration");
    expect(repo.listAll()).toEqual([result.workspace]);
  });

  it("reuses a legacy registration stored under a non-canonical alias", async () => {
    const alias = NodePath.join(directory, "alias");
    await NodeFSPromises.symlink(project, alias, "junction");
    const legacy = await repo.create("Legacy", alias, false);

    const result = await service.create(undefined, alias);

    expect(result).toMatchObject({ ok: true, reused: true, workspace: { id: legacy.id, path: alias } });
    expect(repo.listAll()).toHaveLength(1);
  });

  it("reuses the same folder, including a trailing separator, without a second row", async () => {
    const first = await service.create("Chosen name", project);
    if (!first.ok) throw new Error("Expected successful registration");
    for (const path of [project, `${project}${NodePath.sep}`]) {
      const result = await service.create("Ignored rename", path);
      expect(result).toMatchObject({ ok: true, reused: true, workspace: { id: first.workspace.id, name: "Chosen name", path: project } });
      if (!result.ok) throw new Error("Expected successful reuse");
      expect(repo.listAll()).toEqual([result.workspace]);
    }
  });

  it("expands a folder below home using the browser's tilde syntax", async () => {
    expect(await service.create(undefined, "~/project")).toMatchObject({
      ok: true, reused: false, workspace: { name: "project", path: project },
    });
  });

  it("rejects a missing folder instead of registering its parent", async () => {
    expect(await service.create(undefined, NodePath.join(project, "missing"))).toMatchObject({
      ok: false, error: { code: "path_not_found" },
    });
    expect(repo.listAll()).toEqual([]);
  });

  it("rejects a file", async () => {
    const file = NodePath.join(project, "file.txt");
    await NodeFSPromises.writeFile(file, "fixture");
    expect(await service.create(undefined, file)).toMatchObject({ ok: false, error: { code: "not_a_directory" } });
    expect(repo.listAll()).toEqual([]);
  });

  it("rejects a relative path", async () => {
    expect(await service.create(undefined, "relative/project")).toMatchObject({ ok: false, error: { code: "path_not_absolute" } });
    expect(repo.listAll()).toEqual([]);
  });

  it("rejects home as an absolute path or a tilde path", async () => {
    for (const path of [home, `${home}${NodePath.sep}`, "~", `~${NodePath.sep}`]) {
      expect(await service.create(undefined, path)).toMatchObject({ ok: false, error: { code: "too_broad" } });
    }
    expect(repo.listAll()).toEqual([]);
  });

  it("rejects the filesystem root", async () => {
    expect(await service.create(undefined, NodePath.parse(project).root)).toMatchObject({ ok: false, error: { code: "too_broad" } });
    expect(repo.listAll()).toEqual([]);
  });

  it("canonicalizes directory links before home rejection and workspace reuse", async () => {
    const homeAlias = NodePath.join(directory, "home-alias");
    const projectAlias = NodePath.join(directory, "project-alias");
    await NodeFSPromises.symlink(home, homeAlias, "junction");
    await NodeFSPromises.symlink(project, projectAlias, "junction");
    expect(await service.create(undefined, homeAlias)).toMatchObject({ ok: false, error: { code: "too_broad" } });
    const first = await service.create(undefined, project);
    if (!first.ok) throw new Error("Expected successful registration");
    expect(await service.create(undefined, projectAlias)).toMatchObject({ ok: true, reused: true, workspace: { id: first.workspace.id, path: project } });
    expect(repo.listAll().map((workspace) => workspace.id)).toEqual([first.workspace.id]);
  });

  it.each(["EACCES", "EPERM"])("returns permission_denied when the read check fails with %s", async (code) => {
    vi.mocked(NodeFSPromises.access).mockRejectedValueOnce(Object.assign(new Error("Access denied"), { code }));
    expect(await service.create(undefined, project)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(repo.listAll()).toEqual([]);
  });

  it("does not turn unexpected filesystem failures into validation errors", async () => {
    const failure = Object.assign(new Error("I/O failure"), { code: "EIO" });
    vi.mocked(NodeFSPromises.stat).mockRejectedValueOnce(failure);
    await expect(service.create(undefined, project)).rejects.toBe(failure);
    expect(repo.listAll()).toEqual([]);
  });

  it("evicts a soft-deleted workspace even while it still owns threads", async () => {
    const stale = await repo.create("Deleted", project);
    const thread = await threads.create(stale.id, "Old thread", "direct", "main");
    await repo.softDelete(stale.id);
    const result = await service.create("Replacement", `${project}${NodePath.sep}`);
    expect(result).toMatchObject({ ok: true, reused: false, workspace: { name: "Replacement", path: project } });
    if (!result.ok) throw new Error("Expected replacement registration");
    expect(result.workspace.id).not.toBe(stale.id);
    expect(repo.findByIdIncludeDeleted(stale.id)).toBeNull();
    expect(threads.findById(thread.id)).toBeNull();
    expect(repo.listAll()).toEqual([result.workspace]);
  });
});

describe("workspace.create parameters", () => {
  const schema = WS_METHODS()["workspace.create"].params;

  it("trims values and allows the server to derive the name", () => {
    expect(schema.parse({ path: " /project " })).toEqual({ path: "/project" });
    expect(schema.parse({ path: " /project ", name: " Project " })).toEqual({ path: "/project", name: "Project" });
    expect(schema.parse({ path: "p".repeat(4096), name: "n".repeat(120) })).toEqual({ path: "p".repeat(4096), name: "n".repeat(120) });
  });

  it.each([
    { path: " " },
    { path: "p".repeat(4097) },
    { path: "/project", name: " " },
    { path: "/project", name: "n".repeat(121) },
  ])("rejects empty or overlong parameters %#", (params) => {
    expect(schema.safeParse(params).success).toBe(false);
  });
});
