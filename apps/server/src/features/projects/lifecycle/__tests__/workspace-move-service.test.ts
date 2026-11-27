import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { WorkspaceMoveFrame } from "@mcode/contracts/ws/workspace-move";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseWriteOutcomeUnknown } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { MessageStore } from "../../../agents/conversation/persistence/message-store.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/authority/thread-control-mutation-reservation-service.js";
import { NoProjectWorkspaceSweep } from "../../../thread-control/cleanup/no-project-workspace-sweep.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadStore } from "../../../thread-control/persistence/thread-store.js";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { WorkspaceMoveStore, workspaceMoveWrites } from "../../persistence/workspace-move-store.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { noProjectFolderName } from "../no-project-folder-name.js";
import { markerPath } from "../workspace-move-files.js";
import { assertTerminalOutsideMove } from "../workspace-move-gate.js";
import { WorkspaceMoveService } from "../workspace-move-service.js";

const executeGit = NodeUtil.promisify(NodeChildProcess.execFile);
const NOW = new Date("2026-11-27T12:00:00.000Z");
const DEADLINE = "2026-12-04T12:00:00.000Z";
const EXPIRED = new Date("2026-12-04T12:00:00.001Z");
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

type Options = Partial<ConstructorParameters<typeof WorkspaceMoveService>[1]>;

async function holdWindowsFolder(folder: string): Promise<() => Promise<void>> {
  const child = NodeChildProcess.spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; $file = [IO.File]::Open($env:MCODE_TEST_LOCK_FILE, 'Open', 'Read', 'ReadWrite'); [Console]::WriteLine('locked'); [void][Console]::ReadLine(); $file.Dispose()",
  ], {
    cwd: NodePath.dirname(folder), env: { ...process.env, MCODE_TEST_LOCK_FILE: NodePath.join(folder, "notes.txt") },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
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
    ...runtime, root, id, first, fork, source, parent, destination, input, workspaces, threads, threadStore,
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

  it.each([["EBUSY", "in-use"], ["EPERM", "in-use"], ["EACCES", "permission"]] as const)(
    "leaves a Windows folder in place after the retry budget for %s", async (code, kind) => {
    const f = await fixture();
    let attempts = 0;
    const waits: number[] = [];
    const service = f.makeService({
      platform: "win32",
      rename: async () => {
        throw Object.assign(new Error(`Rename failed on attempt ${++attempts}`), { code });
      },
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(await service.createProject(f.input)).toHaveProperty("operationId");
    expect((await f.terminal).result).toEqual({
      status: "failed", error: "Rename failed on attempt 6", cause: { kind },
    });
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
      expect((await f.terminal).result).toEqual({
        status: "failed", error: "Rename failed on attempt 1", cause: { kind: "other" },
      });
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

function errno(code: string) {
  return Object.assign(new Error(`Injected ${code}`), { code });
}

function crossDriveRename(f: Fixture, platform = process.platform): NonNullable<Options["rename"]> {
  return async (source, destination) => {
    if (source === f.source && destination === f.destination) throw errno("EXDEV");
    // These tests exercise the POSIX claim on Windows, whose own rename cannot replace it.
    if (process.platform === "win32" && platform !== "win32") await NodeFSPromises.rmdir(destination);
    await NodeFSPromises.rename(source, destination);
  };
}

async function startCopy(f: Fixture, options: Options = {}, initGit = false) {
  const service = f.makeService({ rename: crossDriveRename(f, options.platform), ...options });
  const start = await service.createProject({ ...f.input, initGit });
  if (!("operationId" in start)) throw new Error(JSON.stringify(start));
  return { service, ...start, tombstone: NodePath.join(NodePath.dirname(f.source), `.mcode-trash-${start.operationId}`) };
}

async function completedCopy(f: Fixture, options: Options = {}, initGit = false) {
  const move = await startCopy(f, options, initGit);
  expect((await f.terminal).result?.status).toBe(initGit ? "git-failed" : "created");
  await new Promise<void>((resolve) => setImmediate(resolve));
  return move;
}

function atExpiry(f: Fixture, options: Options = {}) {
  return f.makeService({ now: () => EXPIRED, ...options });
}

function sweepAt(f: Fixture, service: WorkspaceMoveService, date: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(date);
  return new NoProjectWorkspaceSweep(f.workspaces, { removeForThread: () => undefined }, f.root, service).run();
}

describe("cross-drive project creation", () => {
  it.each(["win32", "linux", "darwin"] as const)("reclaims the destination and converts every sharer (%s)", async (platform) => {
    const f = await fixture();
    const claims: string[][] = [];
    const rename = crossDriveRename(f, platform);
    const { operationId } = await completedCopy(f, {
      platform,
      rename: async (from, to) => {
        claims.push(NodeFS.existsSync(to) ? NodeFS.readdirSync(to) : ["absent"]);
        await rename(from, to);
      },
    });
    const expectedClaim = platform === "win32" ? ["absent"] : [];
    expect(claims).toEqual([expectedClaim, expectedClaim]);
    expect(f.store.find(operationId)).toMatchObject({
      phase: "done", claimReleased: true, cleanup: "pending", sourceRetainUntil: DEADLINE,
    });
    expect(f.workspaces.findById(f.id)).toMatchObject({ path: f.destination, kind: "project" });
    expect(f.threads.findById(f.first.id)?.workspace_id).toBe(f.id);
    expect(f.threads.findById(f.fork.id)?.workspace_id).toBe(f.id);
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(f.readNotes(f.destination)).toBe("keep these files");
    expect(NodeFS.existsSync(markerPath(f.source, operationId))).toBe(true);
    expect(NodeFS.existsSync(markerPath(f.destination, operationId))).toBe(false);
    expect(NodeFS.readdirSync(f.parent)).toEqual(["NewProject"]);
  });

  it("streams rate-limited byte revisions and serves the same mid-copy state by thread or operation", async () => {
    const f = await fixture();
    const megabyte = 1024 * 1024;
    const payload = Buffer.concat([1, 2, 3, 4, 5].map((value) => Buffer.alloc(megabyte, value)));
    NodeFS.writeFileSync(NodePath.join(f.source, "large.bin"), payload);
    let clock = NOW.getTime();
    const reports: { time: number; frame: WorkspaceMoveFrame; status: WorkspaceMoveFrame | null }[] = [];
    const afterCopy: WorkspaceMoveFrame[] = [];
    const done = Promise.withResolvers<WorkspaceMoveFrame>();
    const service = f.makeService({
      rename: crossDriveRename(f),
      now: () => new Date(clock += 40),
      publishProgress(frame) {
        if (frame.phase === "copying") reports.push({ time: clock, frame, status: service.status({ threadId: f.fork.id }) });
        if (frame.phase === "copied" || frame.phase === "published") afterCopy.push(frame);
        if (frame.result) done.resolve(frame);
      },
    });
    const start = await service.createProject(f.input);
    if (!("operationId" in start)) throw new Error(JSON.stringify(start));
    expect(await done.promise).toMatchObject({ result: { status: "created" }, copiedBytes: null, totalBytes: null });
    expect(reports.length).toBeGreaterThan(1);
    expect(reports[0]?.frame.copiedBytes).toBe(0);
    for (const [index, report] of reports.entries()) {
      expect(report.status).toEqual(report.frame);
      expect(report.frame.totalBytes).toBe(payload.length + 16);
      if (index === 0) continue;
      const previous = reports[index - 1];
      if (!previous) throw new Error("Missing preceding byte frame");
      expect(report.time - previous.time).toBeGreaterThanOrEqual(100);
      expect(report.frame.revision).toBeGreaterThan(previous.frame.revision);
      expect(report.frame.copiedBytes).toBeGreaterThan(previous.frame.copiedBytes ?? 0);
    }
    expect(afterCopy.map((frame) => frame.phase)).toEqual(["copied", "published"]);
    for (const frame of afterCopy) {
      expect(frame).toMatchObject({ copiedBytes: payload.length + 16, totalBytes: payload.length + 16 });
    }
    expect(service.status(start)?.result).toEqual({ status: "created", workspaceId: f.id });
    expect(NodeFS.readFileSync(NodePath.join(f.destination, "large.bin")).equals(payload)).toBe(true);
  });

  it("preserves file metadata and link targets without copying the linked directory", async () => {
    const f = await fixture();
    const file = NodePath.join(f.source, "notes.txt");
    const outside = NodePath.join(f.root, "outside");
    NodeFS.mkdirSync(outside);
    NodeFS.writeFileSync(NodePath.join(outside, "outside.txt"), "do not move");
    NodeFS.chmodSync(file, 0o640);
    NodeFS.utimesSync(file, new Date("2022-01-05T12:34:56Z"), new Date("2023-02-06T01:02:03Z"));
    const original = NodeFS.statSync(file);
    const target = process.platform === "win32" ? outside : "../..//outside";
    NodeFS.symlinkSync(target, NodePath.join(f.source, "outside-link"), process.platform === "win32" ? "junction" : "dir");
    const { operationId } = await completedCopy(f);
    const publishedLink = NodePath.join(f.destination, "outside-link");
    expect(NodeFS.lstatSync(publishedLink).isSymbolicLink()).toBe(true);
    expect(NodeFS.readlinkSync(publishedLink)).toBe(NodeFS.readlinkSync(NodePath.join(f.source, "outside-link")));
    const published = NodeFS.statSync(NodePath.join(f.destination, "notes.txt"));
    expect(published.mode & 0o777).toBe(original.mode & 0o777);
    expect(published.mtimeMs).toBe(original.mtimeMs);
    await atExpiry(f).cleanExpiredSources();
    expect(f.store.find(operationId)?.cleanup).toBe("done");
    expect(NodeFS.readFileSync(NodePath.join(outside, "outside.txt"), "utf8")).toBe("do not move");
  });

  it.each(["ENOSPC", "EPERM"] as const)("reports %s from the copy and removes the owned partial copy", async (code) => {
    const f = await fixture();
    NodeFS.writeFileSync(NodePath.join(f.source, "first.txt"), "already copied");
    const { operationId } = await startCopy(f, {
      openCopyDestination: async (path, flags) => {
        if (NodePath.basename(String(path)) === "notes.txt") throw errno(code);
        return NodeFSPromises.open(path, flags);
      },
    });
    const drive = process.platform === "win32" ? NodePath.parse(f.destination).root.slice(0, -1) : NodePath.parse(f.destination).root;
    expect((await f.terminal).result).toEqual({
      status: "failed", error: `Injected ${code}`, partialCopyRemoved: true,
      cause: code === "ENOSPC" ? { kind: "no-space", drive } : { kind: "permission" },
    });
    await vi.waitFor(() => expect(f.store.find(operationId)?.cleanup).toBe("done"));
    expect(f.workspaces.findById(f.id)?.kind).toBe("no_project");
    expect(NodeFS.readdirSync(f.parent)).toEqual([]);
    expect(f.readNotes(f.source)).toBe("keep these files");
  });

  it("preserves a staging name that was occupied before its exclusive mkdir", async () => {
    const f = await fixture();
    const occupied = Promise.withResolvers<string>();
    const { operationId } = await startCopy(f, {
      writer: {
        execute: async (operation, input) => {
          const result = await f.writer.execute(operation, input);
          if (operation.name === workspaceMoveWrites.advance.name) {
            const [, , next] = workspaceMoveWrites.advance.input.parse(input);
            if (next.stagingPath) {
              NodeFS.mkdirSync(next.stagingPath);
              NodeFS.writeFileSync(NodePath.join(next.stagingPath, "notes.txt"), "someone else's files");
              occupied.resolve(next.stagingPath);
            }
          }
          return result;
        },
      },
    });
    expect((await f.terminal).result).toMatchObject({ status: "failed", partialCopyRemoved: false });
    await vi.waitFor(() => expect(f.store.find(operationId)?.cleanup).toBe("done"));
    expect(f.readNotes(await occupied.promise)).toBe("someone else's files");
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.existsSync(f.destination)).toBe(false);
  });

  it("removes a published copy when workspace conversion loses a project name race", async () => {
    const f = await fixture();
    const rename = crossDriveRename(f);
    const { operationId } = await startCopy(f, {
      rename: async (from, to) => {
        await rename(from, to);
        await f.workspaces.create("NewProject", NodePath.join(f.parent, "competing"), false);
      },
    });
    expect((await f.terminal).result).toMatchObject({
      status: "failed", error: "A project with this name already exists", partialCopyRemoved: true,
    });
    await vi.waitFor(() => expect(f.store.find(operationId)?.cleanup).toBe("done"));
    expect(f.workspaces.findById(f.id)).toMatchObject({ path: f.source, kind: "no_project" });
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.existsSync(f.destination)).toBe(false);
  });

  it.each([false, true])("preserves a late destination when publishing (claimed: %s)", async (claimed) => {
    const f = await fixture();
    const { operationId } = await startCopy(f, {
      rename: async (from, to) => {
        if (from === f.source) throw errno("EXDEV");
        if (process.platform === "win32") NodeFS.mkdirSync(to);
        NodeFS.writeFileSync(NodePath.join(to, "notes.txt"), "late destination data");
        await NodeFSPromises.rename(from, to);
      },
      writer: {
        execute: async (operation, input) => {
          if (operation.name === workspaceMoveWrites.advance.name) {
            const [, , next] = workspaceMoveWrites.advance.input.parse(input);
            if (!claimed && next.phase === "copied") {
              NodeFS.mkdirSync(f.destination);
              NodeFS.writeFileSync(NodePath.join(f.destination, "notes.txt"), "late destination data");
            }
          }
          return f.writer.execute(operation, input);
        },
      },
    });
    expect((await f.terminal).result).toMatchObject({ status: "failed", partialCopyRemoved: true });
    await vi.waitFor(() => expect(f.store.find(operationId)?.cleanup).toBe("done"));
    expect(f.readNotes(f.destination)).toBe("late destination data");
    expect(f.readNotes(f.source)).toBe("keep these files");
  });

  it("closes a terminal owned by a thread that moved out and keeps new starts fenced during the copy", async () => {
    const f = await fixture();
    const other = await f.workspaces.create("Other", NodePath.join(f.parent, "other"), false);
    expect(await f.threads.moveToProject(f.fork.id, other, { kind: "local", branch: "main" }, NOW.toISOString()))
      .toMatchObject({ status: "moved" });
    const stopped = process.platform === "win32" ? await holdWindowsFolder(f.source) : async () => undefined;
    const copyReached = Promise.withResolvers<boolean>();
    const continueCopy = Promise.withResolvers<void>();
    let terminalOpen = true;
    try {
      await startCopy(f, {
        terminals: {
          listActiveSessions: () => terminalOpen ? [{
            ptyId: "old terminal", threadId: f.fork.id, cwd: f.source, state: "running", shell: "powershell",
          }] : [],
          kill: async () => { await stopped(); terminalOpen = false; },
        },
        openCopyDestination: async (path, flags) => {
          copyReached.resolve(terminalOpen);
          await continueCopy.promise;
          return NodeFSPromises.open(path, flags);
        },
      });
      expect(await copyReached.promise).toBe(false);
      for (const folder of [f.source, NodePath.join(f.source, "nested")]) {
        expect(() => assertTerminalOutsideMove(folder, f.workspaces.unfinishedMoveFolders())).toThrow(/moving to a project/);
      }
      continueCopy.resolve();
      expect((await f.terminal).result?.status).toBe("created");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(() => assertTerminalOutsideMove(f.destination, f.workspaces.unfinishedMoveFolders())).not.toThrow();
    } finally {
      continueCopy.resolve();
      await stopped();
    }
  });
});

const COPY_INTERRUPTION_POINTS = [
  "source-marker", "claim-released", "staging-created", "marker-copied", "mid-copy", "copy-finished",
  "published", "converted", "project-marker-removed", "rollback-copy-removed", "rollback-recorded",
] as const;
type CopyInterruptionPoint = typeof COPY_INTERRUPTION_POINTS[number];
type MoveCheckpoint = ReturnType<typeof workspaceMoveWrites.advance.input.parse>[2];
const copyCrashBefore: Partial<Record<CopyInterruptionPoint, (next: MoveCheckpoint) => boolean>> = {
  "claim-released": (next) => Boolean(next.stagingPath),
  "staging-created": (next) => next.phase === "copying" && next.copiedBytes === undefined,
  "marker-copied": (next) => next.phase === "copying" && next.copiedBytes === 0,
  "copy-finished": (next) => next.phase === "copied",
  published: (next) => next.phase === "published",
  "project-marker-removed": (next) => next.phase === "done",
  "rollback-copy-removed": (next) => next.result?.status === "failed",
};
const copyCrashAfter: Partial<Record<CopyInterruptionPoint, (next: MoveCheckpoint) => boolean>> = {
  "rollback-recorded": (next) => next.phase === "done" && next.result?.status === "failed",
};

function expectCopyInterrupted(f: Fixture, operationId: string, step: CopyInterruptionPoint, staging: string) {
  function expectRolledBackCopy(fenced: boolean) {
    expect(NodeFS.existsSync(staging)).toBe(false);
    expect(f.workspaces.hasUnfinishedMove(f.id)).toBe(fenced);
  }
  const assertDisk: Partial<Record<CopyInterruptionPoint, () => void>> = {
    "claim-released": () => {
      expect(f.store.find(operationId)?.stagingPath).toBeNull();
      expect(NodeFS.existsSync(f.destination)).toBe(false);
    },
    "staging-created": () => expect(NodeFS.readdirSync(staging)).toEqual([]),
    "marker-copied": () => expect(NodeFS.readdirSync(staging)).toEqual([NodePath.basename(markerPath(staging, operationId))]),
    "mid-copy": () => expect(NodeFS.readFileSync(NodePath.join(staging, "first.txt"), "utf8")).toBe("copied first"),
    "copy-finished": () => expect(f.readNotes(staging)).toBe("keep these files"),
    published: () => {
      expect(f.store.find(operationId)?.phase).toBe("copied");
      expect(f.readNotes(f.destination)).toBe("keep these files");
    },
    "project-marker-removed": () => expect(NodeFS.existsSync(markerPath(f.destination, operationId))).toBe(false),
    "rollback-copy-removed": () => expectRolledBackCopy(true),
    "rollback-recorded": () => expectRolledBackCopy(false),
  };
  assertDisk[step]?.();
}

describe("cross-drive move recovery", () => {
  it.each(COPY_INTERRUPTION_POINTS)("recovers a real copy interrupted after %s", async (step) => {
    const f = await fixture();
    NodeFS.writeFileSync(NodePath.join(f.source, "first.txt"), "copied first");
    const interrupted = Promise.withResolvers<void>();
    function crash(): never {
      interrupted.resolve();
      throw new DatabaseWriteOutcomeUnknown(`Interrupted after ${step}`);
    }
    const platform = step === "claim-released" ? "linux" : process.platform;
    const { operationId } = await startCopy(f, {
      platform,
      claimDestination: async (path) => {
        if (step === "source-marker") crash();
        await NodeFSPromises.mkdir(path);
      },
      openCopyDestination: async (path, flags) => {
        if (NodePath.basename(String(path)) === "notes.txt") {
          if (step === "mid-copy") crash();
          if (step === "rollback-copy-removed" || step === "rollback-recorded") throw errno("ENOSPC");
        }
        return NodeFSPromises.open(path, flags);
      },
      writer: {
        execute: async (operation, input) => {
          if (operation.name === workspaceMoveWrites.advance.name) {
            const [, , next] = workspaceMoveWrites.advance.input.parse(input);
            if (copyCrashBefore[step]?.(next)) crash();
            const result = await f.writer.execute(operation, input);
            if (copyCrashAfter[step]?.(next)) crash();
            return result;
          }
          const result = await f.writer.execute(operation, input);
          if (step === "converted" && operation.name === workspaceMoveWrites.convert.name) crash();
          return result;
        },
      },
    });
    await interrupted.promise;
    await vi.waitFor(() => expect(f.reservations.get(f.first.id)).toBeUndefined());
    const staging = NodePath.join(f.parent, `.mcode-copy-${operationId}`);
    expectCopyInterrupted(f, operationId, step, staging);
    expect(NodeFS.existsSync(markerPath(f.source, operationId))).toBe(true);
    const unrelated = NodePath.join(f.parent, `.mcode-copy-${crypto.randomUUID()}`);
    NodeFS.mkdirSync(unrelated);
    NodeFS.writeFileSync(NodePath.join(unrelated, "notes.txt"), "unrelated staging data");

    await f.makeService().recoverAtStartup();
    const converted = step === "converted" || step === "project-marker-removed";
    expect(f.store.find(operationId)).toMatchObject({
      phase: "done", cleanup: converted ? "pending" : "done", result: { status: converted ? "created" : "failed" },
    });
    expect(f.workspaces.hasUnfinishedMove(f.id)).toBe(false);
    expect(f.workspaces.findById(f.id)?.path).toBe(converted ? f.destination : f.source);
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.existsSync(markerPath(f.source, operationId))).toBe(converted);
    expect(NodeFS.existsSync(markerPath(f.destination, operationId))).toBe(false);
    expect(NodeFS.existsSync(staging)).toBe(false);
    expect(NodeFS.existsSync(f.destination)).toBe(converted);
    expect(f.readNotes(unrelated)).toBe("unrelated staging data");
  });

  it("keeps an unmatched copy state fenced without removing either folder", async () => {
    const f = await fixture();
    const { operationId, sourceMarker, destinationMarker } = f.interruptedMove();
    const stagingPath = NodePath.join(f.parent, `.mcode-copy-${operationId}`);
    f.storeForCrash.advance(operationId, 1, {
      phase: "copied", stagingPath, cleanup: "done", error: null, result: null, claimReleased: true,
    }, NOW.toISOString());
    NodeFS.writeFileSync(sourceMarker, "");
    for (const folder of [stagingPath, f.destination]) {
      NodeFS.mkdirSync(folder);
      NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "keep this folder");
    }
    NodeFS.writeFileSync(markerPath(stagingPath, operationId), "");
    NodeFS.writeFileSync(destinationMarker, "");

    await f.makeService().recoverAtStartup();
    expect(f.workspaces.hasUnfinishedMove(f.id)).toBe(true);
    expect(f.store.find(operationId)?.result).toMatchObject({
      status: "rollback-pending", partialCopyRemoved: false, cause: { kind: "other" }, markerPath: sourceMarker,
    });
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(f.readNotes(stagingPath)).toBe("keep this folder");
    expect(f.readNotes(f.destination)).toBe("keep this folder");
  });
});

describe("retained cross-drive source", () => {
  it("retains files through the deadline and deletes the checked tombstone with the marker last", async () => {
    const f = await fixture();
    const { operationId, tombstone } = await completedCopy(f);
    const recovery = atExpiry(f, {
      unlink: async (path) => {
        if (String(path) === markerPath(tombstone, operationId)) {
          expect(NodeFS.readdirSync(tombstone)).toEqual([NodePath.basename(String(path))]);
        } else {
          expect(NodeFS.existsSync(markerPath(tombstone, operationId))).toBe(true);
        }
        await NodeFSPromises.unlink(path);
      },
    });
    await sweepAt(f, recovery, new Date(DEADLINE));
    expect(f.store.find(operationId)?.cleanup).toBe("pending");
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.existsSync(tombstone)).toBe(false);

    await sweepAt(f, recovery, EXPIRED);
    expect(f.store.find(operationId)).toMatchObject({ cleanup: "done", tombstonePath: tombstone });
    expect(NodeFS.existsSync(f.source)).toBe(false);
    expect(NodeFS.existsSync(tombstone)).toBe(false);
    expect(f.readNotes(f.destination)).toBe("keep these files");
  });

  it.skipIf(process.platform !== "win32")("retries the tombstone rename after a Windows file handle closes", async () => {
    const f = await fixture();
    const { operationId, tombstone } = await completedCopy(f);
    const closeFile = await holdWindowsFolder(f.source);
    const recovery = atExpiry(f, { sleep: async () => undefined });
    try {
      await recovery.cleanExpiredSources();
      expect(f.store.find(operationId)).toMatchObject({ cleanup: "pending", cleanupError: expect.any(String) });
      expect(f.workspaces.hasUnfinishedMove(f.id)).toBe(false);
      expect(f.readNotes(f.source)).toBe("keep these files");
      expect(NodeFS.existsSync(tombstone)).toBe(false);
    } finally {
      await closeFile();
    }
    await recovery.recoverAtStartup();
    expect(f.store.find(operationId)).toMatchObject({ cleanup: "done", cleanupError: null });
    expect(NodeFS.existsSync(f.source)).toBe(false);
    expect(NodeFS.existsSync(tombstone)).toBe(false);
  });

  it.each(["new-file", "same-size", "missing-manifest"] as const)("keeps a tombstone with %s and leaves a Git failure intact", async (change) => {
    const f = await fixture();
    const file = NodePath.join(f.source, "notes.txt");
    const rename = crossDriveRename(f);
    const { operationId, tombstone } = await completedCopy(f, {
      git: { exec: (args) => args.includes("init") ? Promise.reject(new Error("Git unavailable")) : f.git.exec(args) },
      rename: async (from, to) => {
        if (from !== f.source && change === "same-size") {
          const times = NodeFS.statSync(file);
          NodeFS.writeFileSync(file, "keep these edits");
          NodeFS.utimesSync(file, times.atime, times.mtime);
        }
        await rename(from, to);
      },
    }, true);
    expect(f.store.find(operationId)).toMatchObject({ cleanup: "pending", result: { status: "git-failed" } });
    if (change === "new-file") NodeFS.writeFileSync(NodePath.join(f.source, "extra.txt"), "new source data");
    if (change === "missing-manifest") f.database.prepare("DELETE FROM workspace_move_manifests WHERE move_id = ?").run(operationId);
    await atExpiry(f).recoverAtStartup();
    expect(f.store.find(operationId)).toMatchObject({
      cleanup: "kept", tombstonePath: tombstone, result: { status: "git-failed", error: "Git unavailable" },
    });
    expect(NodeFS.existsSync(markerPath(tombstone, operationId))).toBe(true);
    expect(f.readNotes(f.destination)).toBe("keep these files");
    expect(f.readNotes(tombstone)).toBe(change === "same-size" ? "keep these edits" : "keep these files");
    if (change === "new-file") expect(NodeFS.readFileSync(NodePath.join(tombstone, "extra.txt"), "utf8")).toBe("new source data");
    await atExpiry(f).cleanExpiredSources();
    expect(NodeFS.existsSync(markerPath(tombstone, operationId))).toBe(true);
  });

  it("keeps a markerless source at its old path", async () => {
    const f = await fixture();
    const { operationId, tombstone } = await completedCopy(f);
    NodeFS.unlinkSync(markerPath(f.source, operationId));
    await atExpiry(f).recoverAtStartup();
    expect(f.store.find(operationId)?.cleanup).toBe("kept");
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(NodeFS.existsSync(tombstone)).toBe(false);
  });

  it("keeps the cleanup outcome when a Git retry commits after the expired source was deleted", async () => {
    const f = await fixture();
    const { operationId } = await completedCopy(f, {
      git: { exec: (args) => args.includes("init") ? Promise.reject(new Error("Git unavailable")) : f.git.exec(args) },
    }, true);
    const startingGit = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const service = atExpiry(f, { git: { exec: async (args) => {
      if (args.includes("init")) {
        startingGit.resolve();
        await resumed.promise;
      }
      return f.git.exec(args);
    } } });
    const retry = service.retryGit(operationId);
    await startingGit.promise;
    await service.cleanExpiredSources();
    resumed.resolve();

    expect(await retry).toEqual({ status: "created", workspaceId: f.id });
    expect(f.store.find(operationId)?.cleanup).toBe("done");
    expect(NodeFS.existsSync(f.source)).toBe(false);
  });

  it("preserves a recreated old path through project deletion, the sweep, and later startup", async () => {
    const f = await fixture();
    const { operationId, tombstone } = await completedCopy(f);
    const recovery = atExpiry(f, {
      rename: async (source, target) => {
        await NodeFSPromises.rename(source, target);
        if (source === f.source) {
          NodeFS.mkdirSync(f.source);
          NodeFS.writeFileSync(NodePath.join(f.source, "notes.txt"), "saved at the old path");
          throw new DatabaseWriteOutcomeUnknown("Stopped after source rename");
        }
      },
    });
    await recovery.recoverAtStartup();
    expect(f.store.find(operationId)).toMatchObject({ cleanup: "pending", tombstonePath: tombstone });
    expect(f.readNotes(tombstone)).toBe("keep these files");
    await f.threads.hardDelete(f.fork.id);
    await f.threads.hardDelete(f.first.id);
    expect(await recovery.withDeletion(f.id, () => f.workspaces.hardDelete(f.id))).toBe(true);

    await sweepAt(f, recovery, NOW);
    expect(f.readNotes(f.source)).toBe("saved at the old path");
    expect(NodeFS.existsSync(markerPath(tombstone, operationId))).toBe(true);
    await atExpiry(f).recoverAtStartup();
    await sweepAt(f, recovery, EXPIRED);
    expect(f.readNotes(f.source)).toBe("saved at the old path");
    expect(f.store.find(operationId)?.cleanup).toBe("done");
    expect(NodeFS.existsSync(tombstone)).toBe(false);
  });

  it("protects a marked orphan and a move source after deleting the new project", async () => {
    const f = await fixture();
    const { operationId } = await completedCopy(f);
    const markedOrphan = NodePath.join(NodePath.dirname(f.source), noProjectFolderName(crypto.randomUUID(), "Unregistered", NOW));
    NodeFS.mkdirSync(markedOrphan);
    NodeFS.writeFileSync(markerPath(markedOrphan, crypto.randomUUID()), "");
    NodeFS.writeFileSync(NodePath.join(markedOrphan, "notes.txt"), "marked orphan notes");
    await f.threads.hardDelete(f.fork.id);
    await f.threads.hardDelete(f.first.id);
    expect(await f.workspaces.hardDelete(f.id)).toBe(true);
    await sweepAt(f, atExpiry(f), NOW);
    expect(f.readNotes(f.source)).toBe("keep these files");
    expect(f.readNotes(markedOrphan)).toBe("marked orphan notes");
    await atExpiry(f).recoverAtStartup();
    expect(f.store.find(operationId)?.cleanup).toBe("done");
    expect(NodeFS.existsSync(f.source)).toBe(false);
    expect(f.readNotes(markedOrphan)).toBe("marked orphan notes");
  });
});

const DELETE_INTERRUPTION_POINTS = [
  "tombstone-recorded", "source-renamed", "delete-started", "delete-folder-created", "before-entry-delete",
  "after-nested-delete", "marker-removed", "marker-removed-with-write", "tombstone-removed",
] as const;
type DeleteInterruptionPoint = typeof DELETE_INTERRUPTION_POINTS[number];
type DeleteCheckpoint = ReturnType<typeof workspaceMoveWrites.sourceCleanup.input.parse>[1];
const deleteCrashAfter: Partial<Record<DeleteInterruptionPoint, (next: DeleteCheckpoint) => boolean>> = {
  "tombstone-recorded": (next) => Boolean(next.tombstonePath),
  "delete-started": (next) => next.deleteStagingStarted === true,
};

function expectDeleteInterrupted(input: { f: Fixture; step: DeleteInterruptionPoint; tombstone: string; staging: string; marker: string }) {
  const { f, step, tombstone, staging, marker } = input;
  const assertDisk: Partial<Record<DeleteInterruptionPoint, () => void>> = {
    "tombstone-recorded": () => expect(f.readNotes(f.source)).toBe("keep these files"),
    "source-renamed": () => expect(f.readNotes(tombstone)).toBe("keep these files"),
    "delete-started": () => expect(NodeFS.existsSync(staging)).toBe(false),
    "delete-folder-created": () => expect(NodeFS.readdirSync(staging)).toEqual([]),
    "before-entry-delete": () => expect(NodeFS.readdirSync(staging)).toHaveLength(1),
    "after-nested-delete": () => {
      expect(NodeFS.existsSync(NodePath.join(tombstone, "nested", "child.txt"))).toBe(false);
      expect(NodeFS.existsSync(marker)).toBe(true);
    },
    "marker-removed": () => expect(NodeFS.readdirSync(tombstone)).toEqual([]),
    "tombstone-removed": () => {
      expect(NodeFS.existsSync(f.source)).toBe(false);
      expect(NodeFS.existsSync(tombstone)).toBe(false);
    },
  };
  assertDisk[step]?.();
}

describe("checked source deletion recovery", () => {
  it.each(DELETE_INTERRUPTION_POINTS)("resumes or keeps data after interruption at %s", async (step) => {
    const f = await fixture();
    NodeFS.mkdirSync(NodePath.join(f.source, "nested"));
    NodeFS.writeFileSync(NodePath.join(f.source, "nested", "child.txt"), "nested notes");
    const { operationId, tombstone } = await completedCopy(f);
    let interrupted = false;
    const marker = markerPath(tombstone, operationId);
    const staging = NodePath.join(tombstone, ".mcode-delete");
    function crash(): never {
      interrupted = true;
      throw new DatabaseWriteOutcomeUnknown(`Interrupted at ${step}`);
    }
    const recovery = atExpiry(f, {
      writer: {
        execute: async (operation, input) => {
          if (operation.name !== workspaceMoveWrites.sourceCleanup.name) return f.writer.execute(operation, input);
          const [, next] = workspaceMoveWrites.sourceCleanup.input.parse(input);
          if (step === "tombstone-removed" && next.cleanup === "done") crash();
          const result = await f.writer.execute(operation, input);
          if (deleteCrashAfter[step]?.(next)) crash();
          return result;
        },
      },
      rename: async (from, to) => {
        if (step === "delete-folder-created" && NodePath.dirname(to) === staging) crash();
        await NodeFSPromises.rename(from, to);
        if (step === "source-renamed" && from === f.source) crash();
      },
      unlink: async (path) => {
        const absolute = String(path);
        if (step === "before-entry-delete" && NodePath.dirname(absolute) === staging) crash();
        const nestedEntry = step === "after-nested-delete" && NodePath.dirname(absolute) === staging
          && NodeFS.readFileSync(absolute, "utf8") === "nested notes";
        await NodeFSPromises.unlink(path);
        if (nestedEntry) crash();
        if (absolute === marker && (step === "marker-removed" || step === "marker-removed-with-write")) {
          if (step === "marker-removed-with-write") NodeFS.writeFileSync(NodePath.join(tombstone, "new.txt"), "last-minute data");
          crash();
        }
      },
    });
    await recovery.cleanExpiredSources();
    expect(interrupted).toBe(true);
    expect(f.store.find(operationId)).toMatchObject({ cleanup: "pending", tombstonePath: tombstone });
    expectDeleteInterrupted({ f, step, tombstone, staging, marker });

    await atExpiry(f).recoverAtStartup();
    const kept = step === "marker-removed-with-write";
    expect(f.store.find(operationId)).toMatchObject({
      cleanup: kept ? "kept" : "done", result: { status: "created" }, tombstonePath: tombstone,
    });
    expect(NodeFS.existsSync(f.source)).toBe(false);
    expect(NodeFS.existsSync(tombstone)).toBe(kept);
    if (kept) expect(NodeFS.readFileSync(NodePath.join(tombstone, "new.txt"), "utf8")).toBe("last-minute data");
    expect(f.readNotes(f.destination)).toBe("keep these files");
  });

  it("finishes a marked remnant without recursively deleting anything", async () => {
    const f = await fixture();
    const { operationId, tombstone } = await completedCopy(f);
    f.storeForCrash.sourceCleanup(operationId, { tombstonePath: tombstone }, EXPIRED.toISOString());
    NodeFS.unlinkSync(NodePath.join(f.source, "notes.txt"));
    NodeFS.renameSync(f.source, tombstone);
    const removed: string[] = [];
    await atExpiry(f, { unlink: async (path) => { removed.push(String(path)); await NodeFSPromises.unlink(path); } }).recoverAtStartup();
    expect(removed).toEqual([markerPath(tombstone, operationId)]);
    expect(NodeFS.existsSync(tombstone)).toBe(false);
    expect(f.store.find(operationId)?.cleanup).toBe("done");
  });

  it.each([false, true])("preserves a foreign .mcode-delete directory (already tombstoned: %s)", async (alreadyRenamed) => {
    const f = await fixture();
    const { operationId, tombstone } = await completedCopy(f);
    NodeFS.mkdirSync(NodePath.join(f.source, ".mcode-delete"));
    NodeFS.writeFileSync(NodePath.join(f.source, ".mcode-delete", "0"), "user data");
    if (alreadyRenamed) {
      f.storeForCrash.sourceCleanup(operationId, { tombstonePath: tombstone }, EXPIRED.toISOString());
      NodeFS.renameSync(f.source, tombstone);
      await atExpiry(f).recoverAtStartup();
    } else {
      await sweepAt(f, atExpiry(f), EXPIRED);
    }
    expect(f.store.find(operationId)).toMatchObject({ cleanup: "kept", deleteStagingStarted: false });
    expect(NodeFS.readFileSync(NodePath.join(tombstone, ".mcode-delete", "0"), "utf8")).toBe("user data");
    expect(NodeFS.existsSync(markerPath(tombstone, operationId))).toBe(true);
  });

  it.each(["added", "in-place", "identical-replacement", "edited-replacement"] as const)(
    "preserves %s data written after the unchanged check", async (change) => {
      const f = await fixture();
      const nested = NodePath.join(f.source, "nested");
      NodeFS.mkdirSync(nested);
      NodeFS.writeFileSync(NodePath.join(nested, "child.txt"), "nested notes");
      const { operationId, tombstone } = await completedCopy(f);
      const entry = NodePath.join(tombstone, "nested", "child.txt");
      const added = NodePath.join(tombstone, "nested", "added.txt");
      await atExpiry(f, {
        rename: async (from, to) => {
          if (from === entry) {
            if (change === "added") {
              NodeFS.writeFileSync(added, "added from a shell inside the tombstone");
            } else if (change === "in-place") {
              NodeFS.writeFileSync(entry, "in-place edit");
            } else {
              const temp = NodePath.join(tombstone, "editor-temp");
              NodeFS.writeFileSync(temp, change === "identical-replacement" ? "nested notes" : "atomic edit");
              NodeFS.renameSync(temp, entry);
            }
          }
          await NodeFSPromises.rename(from, to);
        },
      }).cleanExpiredSources();
      expect(f.store.find(operationId)?.cleanup).toBe("kept");
      expect(NodeFS.existsSync(markerPath(tombstone, operationId))).toBe(true);
      if (change === "added") {
        expect(NodeFS.readFileSync(added, "utf8")).toBe("added from a shell inside the tombstone");
      } else {
        const expected = { "in-place": "in-place edit", "identical-replacement": "nested notes", "edited-replacement": "atomic edit" };
        expect(NodeFS.readFileSync(entry, "utf8")).toBe(expected[change]);
        expect(NodeFS.readdirSync(NodePath.join(tombstone, ".mcode-delete"))).toEqual([]);
      }
      expect(NodeFS.readFileSync(NodePath.join(f.destination, "nested", "child.txt"), "utf8")).toBe("nested notes");
    },
  );

  it.each(["same", "other"] as const)("never unlinks a file reached through a substituted folder on the %s drive", async (drive) => {
    const f = await fixture();
    const nested = NodePath.join(f.source, "nested");
    NodeFS.mkdirSync(nested);
    NodeFS.writeFileSync(NodePath.join(nested, "child.txt"), "published notes");
    const { operationId, tombstone } = await completedCopy(f);
    const original = NodePath.join(tombstone, "nested");
    const parked = NodePath.join(tombstone, "parked");
    const published = NodePath.join(f.destination, "nested");
    const staged = Promise.withResolvers<string>();
    await atExpiry(f, {
      rename: async (from, to) => {
        if (from === NodePath.join(original, "child.txt")) {
          NodeFS.renameSync(original, parked);
          NodeFS.symlinkSync(published, original, process.platform === "win32" ? "junction" : "dir");
          staged.resolve(to);
          if (drive === "other") throw errno("EXDEV");
        }
        await NodeFSPromises.rename(from, to);
      },
    }).cleanExpiredSources();

    const candidate = drive === "other" ? NodePath.join(published, "child.txt") : await staged.promise;
    expect(f.store.find(operationId)?.cleanup).toBe("kept");
    expect(NodeFS.readFileSync(candidate, "utf8")).toBe("published notes");
    expect(NodeFS.readFileSync(NodePath.join(parked, "child.txt"), "utf8")).toBe("published notes");
    expect(NodeFS.existsSync(markerPath(tombstone, operationId))).toBe(true);
  });
});
