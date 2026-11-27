import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { WorkspaceMoveFrame } from "@mcode/contracts/ws/workspace-move";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseWriteOutcomeUnknown } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { MessageStore } from "../../../agents/conversation/persistence/message-store.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/authority/thread-control-mutation-reservation-service.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadStore } from "../../../thread-control/persistence/thread-store.js";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { WorkspaceMoveStore, workspaceMoveWrites } from "../../persistence/workspace-move-store.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { noProjectFolderName } from "../no-project-folder-name.js";
import { markerPath } from "../workspace-move-files.js";
import { WorkspaceMoveService } from "../workspace-move-service.js";

const executeGit = NodeUtil.promisify(NodeChildProcess.execFile);
const NOW = new Date("2026-11-27T12:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

type Options = Partial<ConstructorParameters<typeof WorkspaceMoveService>[1]>;

async function holdWindowsFolder(folder: string): Promise<() => Promise<void>> {
  const child = NodeChildProcess.spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; $file = [IO.File]::Open('notes.txt', 'Open', 'Read', 'ReadWrite'); [Console]::WriteLine('locked'); [void][Console]::ReadLine(); $file.Dispose()",
  ], { cwd: folder, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = NodeEvents.once(child, "exit");
  const ready = NodeEvents.once(child.stdout, "data");
  await Promise.race([ready, exited.then(() => { throw new Error("The Windows folder holder did not start"); })]);
  return async () => {
    if (!child.stdin.writableEnded) child.stdin.end("\n");
    await exited;
  };
}

async function fixture() {
  const runtime = createThreadPersistenceTestRuntime();
  const root = await NodeFSPromises.realpath(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-move-")));
  roots.push(root);
  const id = crypto.randomUUID();
  const source = NodePath.join(root, "no-project", noProjectFolderName(id, "Old notes", NOW));
  const parent = NodePath.join(root, "projects");
  const destination = NodePath.join(parent, "NewProject");
  NodeFS.mkdirSync(source, { recursive: true });
  NodeFS.mkdirSync(parent);
  NodeFS.writeFileSync(NodePath.join(source, "notes.txt"), "keep these files");
  const workspaces = new WorkspaceRepo(runtime.reader, runtime.writer);
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const threadStore = new ThreadStore(runtime.database);
  const store = new WorkspaceMoveStore(runtime.reader);
  const storeForCrash = new WorkspaceMoveStore(runtime.database);
  await workspaces.createNoProject(id, source);
  const first = await threads.create(id, "First", "direct", "", false, "codex");
  const fork = await threads.create(id, "Fork", "direct", "", false, "claude", { parentThreadId: first.id });
  const reservations = new ThreadControlMutationReservationService();
  const frames: WorkspaceMoveFrame[] = [];
  const terminal = Promise.withResolvers<WorkspaceMoveFrame>();
  const git = { exec: (args: string[]) => executeGit("git", args) };
  const publishProgress = (frame: WorkspaceMoveFrame) => {
    frames.push(frame);
    if (frame.result) terminal.resolve(frame);
  };
  const input = { threadId: first.id, name: "NewProject", parentPath: parent, initGit: false };
  function makeService(overrides: Options = {}) {
    return new WorkspaceMoveService(root, {
      store, writer: runtime.writer, workspaces, threads, reservations, git,
      runtime: { evictThreadProviderSessions: async () => undefined },
      terminals: { listActiveSessions: () => [], kill: async () => undefined },
      backgroundCommands: { list: () => [] },
      agentWorkload: { backgroundSubagentThreadIds: () => new Set() },
      platform: process.platform,
      publishProgress,
      publishConverted: () => undefined,
      now: () => NOW,
      ...overrides,
    });
  }
  function interruptedMove() {
    const operationId = crypto.randomUUID();
    storeForCrash.start({
      id: operationId, workspaceId: id, name: input.name, sourcePath: source,
      destinationPath: destination, initGit: false, createdAt: NOW.toISOString(),
    }, [first.id, fork.id]);
    return { operationId, sourceMarker: markerPath(source, operationId), destinationMarker: markerPath(destination, operationId) };
  }
  function readNotes(path: string) {
    return NodeFS.readFileSync(NodePath.join(path, "notes.txt"), "utf8");
  }
  return {
    ...runtime, id, first, fork, source, parent, destination, input, workspaces, threads, threadStore,
    reservations, frames, makeService, interruptedMove, terminal: terminal.promise, store, storeForCrash, git, readNotes,
  };
}

describe("same-drive project creation", () => {
  it("returns the intent before mutation, publishes revisions, and converts every sharer in place", async () => {
    const f = await fixture();
    const stopping = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const workspaceEvent = Promise.withResolvers<string[]>();
    const service = f.makeService({
      runtime: { evictThreadProviderSessions: () => {
        stopping.resolve();
        return stopped.promise;
      } },
      publishConverted: (workspace, sharers) => workspaceEvent.resolve([workspace.id, ...sharers.map(({ thread }) => thread.id)]),
    });
    const creating = service.createProject(f.input);
    await stopping.promise;
    expect(await service.createProject({ ...f.input, threadId: f.fork.id })).toMatchObject({ status: "failed" });
    expect(await service.withDeletion(f.id, async () => true)).toBe(false);
    await expect(f.threads.create(f.id, "Incoming fork", "direct", "", false, "codex", {
      parentThreadId: f.first.id,
    })).rejects.toThrow(/moving/);
    const startups = new ThreadStartupService(new ThreadStartupRepo(f.reader, f.writer), f.writer);
    await expect(startups.createAndBindThread(crypto.randomUUID(), {
      args: [f.id, "Delegated child", "direct", "", false, "codex", {
        delegation: { coordinatorThreadId: f.first.id, creatorTurnId: "turn", creatorToolCallId: "tool" },
      }, undefined, undefined],
    })).rejects.toThrow(/moving/);
    stopped.resolve();
    const result = await creating;
    if (!("operationId" in result)) throw new Error(JSON.stringify(result));
    expect(NodeFS.readdirSync(f.source)).toEqual(["notes.txt"]);
    const expectedIntent = {
      operationId: result.operationId, revision: 1, phase: "intent", copiedBytes: null, totalBytes: null,
    };
    expect(service.status({ threadId: f.first.id })).toEqual(expectedIntent);
    expect(service.status({ threadId: f.fork.id })).toEqual(expectedIntent);
    expect(service.status(result)).toEqual(expectedIntent);
    const done = await f.terminal;
    expect(done.result).toEqual({ status: "created", workspaceId: f.id });
    expect(service.status(result)).toEqual(done);
    expect(service.status({ threadId: f.fork.id })).toBeNull();
    expect(f.frames.map(({ phase, revision }) => [phase, revision])).toEqual([
      ["intent", 1], ["renamed", 2], ["converted", 3], ["converted", 4], ["done", 5],
    ]);
    expect(await workspaceEvent.promise).toEqual([f.id, f.first.id, f.fork.id]);
    expect(f.workspaces.findById(f.id)).toMatchObject({ kind: "project", path: f.destination, name: "NewProject", is_git_repo: false });
    expect(f.readNotes(f.destination)).toBe("keep these files");
    expect(NodeFS.existsSync(f.source)).toBe(false);
    const messages = new MessageStore(f.database);
    for (const thread of [f.first, f.fork]) {
      expect(f.threads.findById(thread.id)).toMatchObject({ workspace_id: f.id, branch: "main", sdk_session_id: null });
      expect(f.threads.readRelocation(thread.id)).toEqual({ workspaceId: null, freshSession: true, noteGeneration: 0, notePending: false });
      expect(messages.listByThread(thread.id, 10).messages.map(({ threadMove }) => threadMove)).toContainEqual({
        target: "new-project", projectName: "NewProject",
      });
    }
  });

  it.each(["?", ".", "..", "con", "PrN.log", "AUX", "nul", "com9.extension", "LPT1", "end.", "end "])(
    "rejects the invalid project name %s before recording an intent", async (name) => {
      const f = await fixture();
      expect(await f.makeService().createProject({ ...f.input, name })).toMatchObject({ status: "failed", error: "Invalid project name" });
      expect(f.readNotes(f.source)).toBe("keep these files");
      expect(f.frames).toEqual([]);
    },
  );

  it("rejects a case-insensitive duplicate, an occupied destination, and either managed parent", async () => {
    const f = await fixture();
    const service = f.makeService();
    await f.workspaces.create("oThEr", NodePath.join(f.parent, "old"), false);
    expect(await service.createProject({ ...f.input, name: "Other" })).toMatchObject({ status: "failed", error: /already exists/ });
    NodeFS.writeFileSync(f.destination, "unrelated file");
    expect(await service.createProject(f.input)).toMatchObject({ status: "failed", error: /already exists/ });
    for (const parentPath of [f.source, NodePath.dirname(f.source)]) {
      expect(await service.createProject({ ...f.input, parentPath })).toMatchObject({ status: "failed", error: /inside/ });
    }
    expect(NodeFS.readFileSync(f.destination, "utf8")).toBe("unrelated file");
    expect(f.frames).toEqual([]);
  });

  it("resolves home on the server before checking the destination", async () => {
    const f = await fixture();
    const name = NodePath.basename(NodeOS.homedir());
    const parentOfHome = NodePath.dirname(NodeOS.homedir());
    const parentPath = `~/${NodePath.relative(NodeOS.homedir(), parentOfHome)}`;
    expect(await f.makeService().createProject({ ...f.input, name, parentPath })).toMatchObject({
      status: "failed", error: /destination already exists/,
    });
  });

  it.each([["pendingApproval", "needs-approval"], ["activeTurn", "running"]] as const)(
    "names a busy sharer holding %s", async (state, reason) => {
      const f = await fixture();
      f.reservations.reserve(f.fork.id, state);
      expect(await f.makeService().createProject(f.input)).toEqual({ status: "busy", threadId: f.fork.id, reason });
      expect(f.reservations.get(f.first.id)).toBeUndefined();
      expect(f.readNotes(f.source)).toBe("keep these files");
    },
  );

  it("leaves an open terminal running when the move intent is refused", async () => {
    const f = await fixture();
    f.database.exec(`
      CREATE TRIGGER refuse_move_intent BEFORE INSERT ON workspace_moves
      BEGIN SELECT RAISE(ABORT, 'test refused move intent'); END;
    `);
    let terminalOpen = true;
    const service = f.makeService({
      terminals: {
        listActiveSessions: () => terminalOpen ? [{
          ptyId: "open terminal", threadId: f.first.id, cwd: f.source, state: "running", shell: "powershell",
        }] : [],
        kill: async () => { terminalOpen = false; },
      },
    });

    expect(await service.createProject(f.input)).toMatchObject({
      status: "failed", error: expect.stringContaining("test refused move intent"),
    });
    expect(terminalOpen).toBe(true);
    expect(f.store.findUnfinished(f.id)).toBeNull();
  });

  it("leaves a late destination untouched when the exclusive claim fails", async () => {
    const f = await fixture();
    const service = f.makeService({ runtime: { evictThreadProviderSessions: async (threadId) => {
      if (threadId !== f.first.id) return;
      NodeFS.mkdirSync(f.destination);
      NodeFS.writeFileSync(NodePath.join(f.destination, "foreign.txt"), "destination belongs to someone else");
    } } });
    expect(await service.createProject(f.input)).toHaveProperty("operationId");
    expect((await f.terminal).result).toMatchObject({ status: "failed" });
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.readdirSync(f.destination)).toEqual(["foreign.txt"]);
    expect(NodeFS.readFileSync(NodePath.join(f.destination, "foreign.txt"), "utf8")).toBe("destination belongs to someone else");
  });

  it("preserves a file written into a claimed destination before rename", async () => {
    const f = await fixture();
    const service = f.makeService({ claimDestination: async (path) => {
      await NodeFSPromises.mkdir(path);
      await NodeFSPromises.writeFile(NodePath.join(path, "foreign.txt"), "keep the new file");
    } });
    expect(await service.createProject(f.input)).toHaveProperty("operationId");
    expect((await f.terminal).result).toMatchObject({ status: "failed" });
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.readdirSync(f.destination)).toEqual(["foreign.txt"]);
    expect(NodeFS.readFileSync(NodePath.join(f.destination, "foreign.txt"), "utf8")).toBe("keep the new file");
  });

  it("creates the project when a Windows rename succeeds after two busy failures", async () => {
    const f = await fixture();
    let attempts = 0;
    const service = f.makeService({
      platform: "win32",
      rename: async (source, destination) => {
        if (++attempts <= 2) throw Object.assign(new Error("Folder in use"), { code: "EBUSY" });
        await NodeFSPromises.rename(source, destination);
      },
      sleep: async () => undefined,
    });
    expect(await service.createProject(f.input)).toHaveProperty("operationId");
    expect((await f.terminal).result).toEqual({ status: "created", workspaceId: f.id });
    expect(f.workspaces.findById(f.id)).toMatchObject({ path: f.destination, kind: "project" });
    expect(f.readNotes(f.destination)).toBe("keep these files");
    expect(NodeFS.existsSync(f.source)).toBe(false);
  });

  it("leaves a persistently busy Windows folder in place after the retry budget", async () => {
    const f = await fixture();
    let attempts = 0;
    const waits: number[] = [];
    const service = f.makeService({
      platform: "win32",
      rename: async () => {
        throw Object.assign(new Error(`Folder in use on attempt ${++attempts}`), { code: "EBUSY" });
      },
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(await service.createProject(f.input)).toHaveProperty("operationId");
    expect((await f.terminal).result).toEqual({ status: "failed", error: "Folder in use on attempt 6" });
    expect(waits).toEqual([100, 200, 400, 800, 1500]);
    expect(f.workspaces.findById(f.id)).toMatchObject({ path: f.source, kind: "no_project" });
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.existsSync(f.destination)).toBe(false);
  });

  it.each([["linux", "EBUSY"], ["win32", "ENOENT"]] as const)(
    "fails the move without retrying %s %s", async (platform, code) => {
      const f = await fixture();
      let attempts = 0;
      const waits: number[] = [];
      const service = f.makeService({
        platform,
        rename: async () => {
          throw Object.assign(new Error(`Rename failed on attempt ${++attempts}`), { code });
        },
        sleep: async (ms) => { waits.push(ms); },
      });
      expect(await service.createProject(f.input)).toHaveProperty("operationId");
      expect((await f.terminal).result).toEqual({ status: "failed", error: "Rename failed on attempt 1" });
      expect(waits).toEqual([]);
      expect(f.readNotes(f.source)).toBe("keep these files");
      expect(NodeFS.existsSync(f.destination)).toBe(false);
    },
  );

  it.skipIf(process.platform !== "win32").each([false, true])(
    "releases real Windows handles before rename (terminal owner moved out: %s)", async (movedOut) => {
      const f = await fixture();
      if (movedOut) {
        const other = await f.workspaces.create("Other", NodePath.join(f.parent, "other"), false);
        expect(await f.threads.moveToProject(f.fork.id, other, { kind: "local", branch: "main" }, NOW.toISOString()))
          .toMatchObject({ status: "moved" });
      }
      const stopRuntime = await holdWindowsFolder(f.source);
      const closeTerminal = await holdWindowsFolder(f.source);
      try {
        expect(() => NodeFS.renameSync(f.source, f.destination)).toThrow();
        const service = f.makeService({
          runtime: { evictThreadProviderSessions: async (id) => { if (id === f.first.id) await stopRuntime(); } },
          terminals: {
            listActiveSessions: () => [{
              ptyId: "open terminal", threadId: f.fork.id, cwd: f.source, state: "running", shell: "powershell",
            }],
            kill: closeTerminal,
          },
        });
        expect(await service.createProject(f.input)).toHaveProperty("operationId");
        expect((await f.terminal).result).toMatchObject({ status: "created" });
        expect(f.readNotes(f.destination)).toBe("keep these files");
      } finally {
        await stopRuntime();
        await closeTerminal();
      }
    },
  );

  it("leaves the project usable after a Git failure and retries only its Git initialization", async () => {
    const f = await fixture();
    const service = f.makeService({ git: { exec: (args) => {
      if (args.includes("init")) return Promise.reject(new Error("fatal: Git can't create .git"));
      return f.git.exec(args);
    } } });
    const start = await service.createProject({ ...f.input, initGit: true });
    if (!("operationId" in start)) throw new Error(JSON.stringify(start));
    expect((await f.terminal).result).toEqual({ status: "git-failed", workspaceId: f.id, error: "fatal: Git can't create .git" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.workspaces.hasUnfinishedMove(f.id)).toBe(false);
    expect(f.workspaces.findById(f.id)?.is_git_repo).toBe(false);
    const retry = f.makeService();
    expect(await retry.retryGit("unrelated")).toMatchObject({ status: "failed" });
    expect(await retry.retryGit(start.operationId)).toEqual({ status: "created", workspaceId: f.id });
    expect(f.workspaces.findById(f.id)?.is_git_repo).toBe(true);
    expect(await retry.retryGit(start.operationId)).toMatchObject({ status: "failed" });
    expect(f.frames.filter(({ result }) => result)).toHaveLength(1);
    expect((await f.git.exec(["-C", f.destination, "rev-parse", "--show-toplevel"])).stdout.trim()).not.toBe("");
  });
});

describe("folder move startup recovery", () => {
  it("rolls back a renamed Windows folder after transient permission errors", async () => {
    const f = await fixture();
    const { operationId, sourceMarker } = f.interruptedMove();
    NodeFS.writeFileSync(sourceMarker, "", { flag: "wx" });
    NodeFS.renameSync(f.source, f.destination);
    const failures = ["EPERM", "EACCES"];
    const service = f.makeService({
      platform: "win32",
      rename: async (source, destination) => {
        const code = failures.shift();
        if (code) throw Object.assign(new Error("Folder in use"), { code });
        await NodeFSPromises.rename(source, destination);
      },
      sleep: async () => undefined,
    });
    await service.recoverAtStartup();
    expect(service.status({ operationId })).toMatchObject({ phase: "done", result: { status: "failed" } });
    expect(f.workspaces.findById(f.id)).toMatchObject({ path: f.source, kind: "no_project" });
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.readdirSync(f.source)).toEqual(["notes.txt"]);
    expect(NodeFS.existsSync(f.destination)).toBe(false);
  });

  it.each(["source-marker", "claim", "renamed", "converted", "git-init", "marker-removed"] as const)(
    "recovers the real directory when interrupted after %s", async (step) => {
    const f = await fixture();
    const interrupted = Promise.withResolvers<void>();
    const rollForward = step === "converted" || step === "git-init" || step === "marker-removed";
    function loseServer(): never {
      interrupted.resolve();
      throw new DatabaseWriteOutcomeUnknown(`Interrupted after ${step}`);
    }
    const service = f.makeService({
      claimDestination: async (path) => {
        if (step === "source-marker") loseServer();
        await NodeFSPromises.mkdir(path);
        if (step === "claim") loseServer();
      },
      writer: {
        execute: async (operation, input) => {
          if (operation.name === workspaceMoveWrites.advance.name) {
            const [, , next] = workspaceMoveWrites.advance.input.parse(input);
            if (next.phase === "renamed" && step === "renamed") loseServer();
            if (next.phase === "converted" && step === "git-init") loseServer();
            if (next.phase === "done" && step === "marker-removed") loseServer();
          }
          const result = await f.writer.execute(operation, input);
          if (operation.name === workspaceMoveWrites.convert.name && step === "converted") loseServer();
          return result;
        },
      },
    });
    const start = await service.createProject({ ...f.input, initGit: rollForward });
    if (!("operationId" in start)) throw new Error(JSON.stringify(start));
    await interrupted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (step === "renamed") {
      expect(service.status(start)?.phase).toBe("intent");
      expect(f.readNotes(f.destination)).toBe("keep these files");
    }
    const recovery = f.makeService();
    await recovery.recoverAtStartup();
    expect(recovery.status(start)).toMatchObject({
      phase: "done",
      result: { status: rollForward ? "created" : "failed" },
    });
    const retained = rollForward ? f.destination : f.source;
    expect(f.readNotes(retained)).toBe("keep these files");
    expect(NodeFS.existsSync(markerPath(retained, start.operationId))).toBe(false);
    expect(NodeFS.existsSync(rollForward ? f.source : f.destination)).toBe(false);
    expect(f.workspaces.findById(f.id)).toMatchObject({
      path: retained, kind: rollForward ? "project" : "no_project", is_git_repo: rollForward,
    });
  });

  it("removes a claimed directory that contains only its ownership marker", async () => {
    const f = await fixture();
    const { operationId, sourceMarker, destinationMarker } = f.interruptedMove();
    NodeFS.writeFileSync(sourceMarker, "", { flag: "wx" });
    NodeFS.mkdirSync(f.destination);
    NodeFS.writeFileSync(destinationMarker, "", { flag: "wx" });
    const recovery = f.makeService();
    await recovery.recoverAtStartup();
    expect(recovery.status({ operationId })).toMatchObject({ phase: "done", result: { status: "failed" } });
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.readdirSync(f.source)).toEqual(["notes.txt"]);
    expect(NodeFS.existsSync(f.destination)).toBe(false);
    expect(f.workspaces.findById(f.id)).toMatchObject({ path: f.source, kind: "no_project" });
  });

  it("retries pending marker cleanup after the failure has already lifted the fence", async () => {
    const f = await fixture();
    const crashed = Promise.withResolvers<void>();
    const service = f.makeService({
      claimDestination: () => Promise.reject(new Error("claim failed")),
      writer: {
        execute: async (operation, input) => {
          const result = await f.writer.execute(operation, input);
          if (operation.name === workspaceMoveWrites.advance.name) {
            crashed.resolve();
            throw new DatabaseWriteOutcomeUnknown("server stopped after recording the rollback");
          }
          return result;
        },
      },
    });
    const start = await service.createProject(f.input);
    if (!("operationId" in start)) throw new Error(JSON.stringify(start));
    await crashed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.store.find(start.operationId)?.cleanup).toBe("pending");
    expect(NodeFS.existsSync(markerPath(f.source, start.operationId))).toBe(true);
    expect(f.workspaces.hasUnfinishedMove(f.id)).toBe(false);
    await f.makeService().recoverAtStartup();
    expect(f.store.find(start.operationId)?.cleanup).toBe("done");
    expect(NodeFS.readdirSync(f.source)).toEqual(["notes.txt"]);
  });

  it("keeps a blocked rollback fenced, then settles it before deletion can proceed", async () => {
    const f = await fixture();
    const { operationId, sourceMarker, destinationMarker } = f.interruptedMove();
    NodeFS.writeFileSync(sourceMarker, "", { flag: "wx" });
    NodeFS.renameSync(f.source, f.destination);
    NodeFS.mkdirSync(f.source);
    const collision = NodePath.join(f.source, "unrelated");
    NodeFS.writeFileSync(collision, "collision");
    const service = f.makeService();
    await service.recoverAtStartup();
    expect(service.status({ operationId })).toMatchObject({ phase: "intent", result: {
      status: "rollback-pending", markerPath: destinationMarker,
    } });
    expect(await service.withDeletion(f.id, async () => true)).toBe(false);
    await expect(f.threads.create(f.id, "A new thread", "direct", "", false)).rejects.toThrow(/moving/);
    expect(f.readNotes(f.destination)).toBe("keep these files");
    expect(NodeFS.readFileSync(collision, "utf8")).toBe("collision");
    NodeFS.unlinkSync(collision);
    NodeFS.rmdirSync(f.source);
    expect(await service.withDeletion(f.id, async () => f.readNotes(f.source) === "keep these files")).toBe(true);
    expect(f.workspaces.hasUnfinishedMove(f.id)).toBe(false);
  });

  it("rechecks an old sweep candidate against the move intent before deleting", async () => {
    const f = await fixture();
    f.database.query("DELETE FROM threads WHERE workspace_id = ?").run(f.id);
    const sweptAt = "2099-12-30T00:00:00.000Z";
    const createdBefore = "2099-12-29T00:00:00.000Z";
    const retrySince = "2099-12-23T00:00:00.000Z";
    expect(f.workspaces.findRemovableNoProject(createdBefore, retrySince, sweptAt).map((workspace) => workspace.id))
      .toEqual([f.id]);
    f.interruptedMove();
    expect(f.workspaces.findRemovableNoProject(createdBefore, retrySince, sweptAt)).toEqual([]);
    expect(await f.workspaces.deleteRemovableNoProject(f.id, createdBefore, retrySince, sweptAt)).toBe(false);
    expect(f.readNotes(f.source)).toBe("keep these files");
  });

});
