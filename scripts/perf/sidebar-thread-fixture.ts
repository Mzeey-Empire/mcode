import "../../apps/server/node_modules/reflect-metadata/Reflect.js";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { WorkspaceStore } from "../../apps/server/src/features/projects/persistence/workspace-store.js";
import { ThreadStore } from "../../apps/server/src/features/thread-control/persistence/thread-store.js";
import { openDatabase } from "../../apps/server/src/runtime/persistence/sqlite/database.js";
import {
  SIDEBAR_STREAM_TARGET_TITLE,
  parseSidebarThreadCount,
  planSidebarThreads,
  resolveSidebarFixtureDatabasePath,
  sidebarWorkspaceNames,
} from "./sidebar-thread-fixture-plan.mjs";

const MARKER = "__mcode_perf_sidebar__";

interface Descriptor {
  marker: string;
  dbPath: string;
  requestedThreadCount: number;
  seededThreadCount: number;
  workspaces: readonly { id: string; name: string; path: string; threadCount: number }[];
  streamTarget: { id: string; title: string; workspaceName: string };
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function descriptorPath(repoRoot: string): string {
  const requested = arg("--descriptor");
  if (!requested || !/^sidebar-thread-fixture(-electron)?\.json$/.test(NodePath.basename(requested))) {
    throw new Error("--descriptor must name sidebar-thread-fixture.json or sidebar-thread-fixture-electron.json");
  }
  const path = NodePath.resolve(repoRoot, requested);
  if (NodePath.dirname(path) !== NodePath.join(repoRoot, ".dev", "verification", "performance")) {
    throw new Error("--descriptor must live in .dev/verification/performance");
  }
  return path;
}

function workspacePaths(repoRoot: string): string[] {
  return sidebarWorkspaceNames().map((name) => NodePath.join(repoRoot, ".dev", "fixture-repo", name));
}

function removeSeededRows(db: Database, repoRoot: string): void {
  const findWorkspace = db.query<{ id: string }, [string]>("SELECT id FROM workspaces WHERE path = ?");
  const owned = workspacePaths(repoRoot).flatMap((path) => findWorkspace.all(path).map((row) => row.id));
  if (owned.length === 0) return;
  const deleteThreads = db.query("DELETE FROM threads WHERE workspace_id = ?");
  const deleteWorkspace = db.query("DELETE FROM workspaces WHERE id = ?");
  db.transaction(() => {
    for (const id of owned) {
      deleteThreads.run(id);
      deleteWorkspace.run(id);
    }
  })();
}

function seed(repoRoot: string, dbPath: string, count: number): Descriptor {
  if (!NodeFS.existsSync(NodePath.join(repoRoot, ".dev", "fixture-repo", ".git"))) {
    throw new Error("Run `bun run agent:setup` first: the sidebar fixture needs .dev/fixture-repo.");
  }
  const db = openDatabase({ dbPath });
  try {
    removeSeededRows(db, repoRoot);
    const setActivity = db.query(
      "UPDATE threads SET created_at = ?, updated_at = ?, last_turn_ended_at = ?, last_turn_outcome = ?, user_completed_at = ? WHERE id = ?",
    );
    const workspaceStore = new WorkspaceStore(db);
    const threadStore = new ThreadStore(db);
    const plan = planSidebarThreads(count, Date.now());
    const descriptor = db.transaction(() => {
      const created = workspacePaths(repoRoot).map((path, index) => {
        NodeFS.mkdirSync(path, { recursive: true });
        return { ...workspaceStore.create(sidebarWorkspaceNames()[index] ?? path, path), threadCount: 0 };
      });
      let streamTargetId: string | null = null;
      for (const planned of plan) {
        const workspace = created[planned.workspaceIndex];
        if (!workspace) throw new Error("Thread plan named a workspace that was not created.");
        const thread = threadStore.create(workspace.id, planned.title, "direct", "main", false, "codex");
        setActivity.run(
          planned.createdAt,
          planned.updatedAt,
          planned.lastTurnEndedAt,
          planned.lastTurnOutcome,
          planned.userCompletedAt,
          thread.id,
        );
        workspace.threadCount += 1;
        if (planned.title === SIDEBAR_STREAM_TARGET_TITLE) streamTargetId = thread.id;
      }
      if (!streamTargetId || !created[0]) throw new Error("The thread plan did not include the stream target.");
      return {
        marker: MARKER,
        dbPath,
        requestedThreadCount: count,
        seededThreadCount: plan.length,
        workspaces: created.map(({ id, name, path, threadCount }) => ({ id, name, path, threadCount })),
        streamTarget: { id: streamTargetId, title: SIDEBAR_STREAM_TARGET_TITLE, workspaceName: created[0].name },
      };
    })();
    return descriptor;
  } catch (error) {
    removeSeededRows(db, repoRoot);
    throw error;
  } finally {
    db.close(true);
  }
}

function cleanup(repoRoot: string, dbPath: string): void {
  const db = openDatabase({ dbPath });
  try {
    removeSeededRows(db, repoRoot);
  } finally {
    db.close(true);
  }
}

const repoRoot = process.cwd();
const action = arg("--action");
const dbPath = resolveSidebarFixtureDatabasePath(repoRoot, arg("--db-path") ?? undefined);
const path = descriptorPath(repoRoot);
if (action === "seed") {
  const descriptor = seed(repoRoot, dbPath, parseSidebarThreadCount(arg("--threads") ?? ""));
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(descriptor)}\n`);
} else if (action === "cleanup") {
  cleanup(repoRoot, dbPath);
  NodeFS.rmSync(path, { force: true });
} else {
  throw new Error("--action must be seed or cleanup");
}
