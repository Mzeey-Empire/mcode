import type { Database } from "bun:sqlite";
import * as NodePath from "node:path";
import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { MessageSchema } from "@mcode/contracts/models/message";
import { ThreadSchema } from "@mcode/contracts/models/thread";
import { WorkspaceMovePhaseSchema, WorkspaceMoveResultSchema } from "@mcode/contracts/ws/workspace-move";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";
import { threads, workspaceMoveManifests, workspaceMoves, workspaces } from "../../../runtime/persistence/sqlite/schema.js";
import { ThreadStore } from "../../thread-control/persistence/thread-store.js";

/** A durable move at the last committed checkpoint. */
export type WorkspaceMove = typeof workspaceMoves.$inferSelect;

const relativePath = z.string().refine((path) =>
  !NodePath.isAbsolute(path) && !path.includes("\0") && NodePath.normalize(path) === path
  && path.split(NodePath.sep).every((part) => part !== "" && part !== "." && part !== ".."
    && (NodePath.sep !== "\\" || !part.includes(":"))),
);
const inode = z.string().regex(/^\d+$/);
const manifestEntries = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), path: relativePath }),
  z.object({
    kind: z.literal("file"), path: relativePath, inode, size: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({ kind: z.literal("link"), path: relativePath, inode, target: z.string() }),
]));

/** Copy evidence for each entry at its original path and manifest index. */
export type WorkspaceMoveManifest = z.infer<typeof manifestEntries>;

const intent = z.object({
  id: z.string().uuid(),
  workspaceId: z.string(),
  name: z.string(),
  sourcePath: z.string(),
  destinationPath: z.string(),
  initGit: z.boolean(),
  createdAt: z.string().datetime(),
});
const checkpoint = z.object({
  phase: WorkspaceMovePhaseSchema().optional(),
  result: WorkspaceMoveResultSchema().nullable().optional(),
  cleanup: z.enum(["done", "pending", "kept"]).optional(),
  error: z.string().nullable().optional(),
  stagingPath: z.string().nullable().optional(),
  claimReleased: z.boolean().optional(),
  copiedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  sourceRetainUntil: z.string().datetime().optional(),
  manifest: manifestEntries.optional(),
});
const sourceCleanup = z.object({
  cleanup: z.enum(["done", "pending", "kept"]).optional(),
  tombstonePath: z.string().optional(),
  deleteStagingStarted: z.boolean().optional(),
  cleanupError: z.string().nullable().optional(),
});
const placement = z.object({
  isGitRepo: z.boolean(), branch: z.string(),
});
const convertedThread = z.object({ thread: ThreadSchema(), marker: MessageSchema() });

export const workspaceMoveWrites = {
  start: databaseWriteOperation("workspace.move.start", z.tuple([intent, z.array(z.string())]), z.void()),
  advance: databaseWriteOperation("workspace.move.advance", z.tuple([
    z.string(), z.number().int(), checkpoint, z.string().datetime(), placement.optional(),
  ]), z.void()),
  convert: databaseWriteOperation("workspace.move.convert", z.tuple([
    z.string(), placement, z.string().datetime(),
  ]), z.array(convertedThread)),
  sourceCleanup: databaseWriteOperation("workspace.move.sourceCleanup", z.tuple([
    z.string(), sourceCleanup, z.string().datetime(),
  ]), z.void()),
};

export function unfinishedWorkspaceMove(workspaceId: typeof workspaces.id | string) {
  return and(eq(workspaceMoves.workspaceId, workspaceId), ne(workspaceMoves.phase, "done"));
}

export class WorkspaceMoveStore {
  private readonly orm;

  constructor(private readonly db: Database) {
    this.orm = drizzle(db);
  }

  find(id: string): WorkspaceMove | null {
    return this.orm.select().from(workspaceMoves).where(eq(workspaceMoves.id, id)).get() ?? null;
  }

  findUnfinished(workspaceId: string): WorkspaceMove | null {
    return this.orm.select().from(workspaceMoves).where(unfinishedWorkspaceMove(workspaceId)).get() ?? null;
  }

  listRecoverable(): WorkspaceMove[] {
    return this.orm.select().from(workspaceMoves).where(sql`
      ${workspaceMoves.phase} <> 'done' OR (${workspaceMoves.cleanup} = 'pending' AND ${workspaceMoves.sourceRetainUntil} IS NULL)
    `).all();
  }

  /** Find completed moves whose retained source is ready for a cleanup attempt. */
  listExpiredSources(now: string): WorkspaceMove[] {
    return this.orm.select().from(workspaceMoves).where(and(
      eq(workspaceMoves.phase, "done"), eq(workspaceMoves.cleanup, "pending"), lt(workspaceMoves.sourceRetainUntil, now),
    )).all();
  }

  /** Keep even a markerless folder recreated at a recorded source or tombstone path. */
  protectsFolder(path: string): boolean {
    const paths = this.orm.select({ source: workspaceMoves.sourcePath, tombstone: workspaceMoves.tombstonePath })
      .from(workspaceMoves).all();
    return paths.some(({ source, tombstone }) =>
      NodePath.relative(path, source) === "" || (tombstone !== null && NodePath.relative(path, tombstone) === ""));
  }

  /** Read and validate copy evidence before it is used to delete anything. */
  readManifest(id: string): WorkspaceMoveManifest | null {
    const stored = this.orm.select({ entries: workspaceMoveManifests.entries }).from(workspaceMoveManifests)
      .where(eq(workspaceMoveManifests.moveId, id)).get();
    const parsed = manifestEntries.safeParse(stored?.entries);
    return parsed.success ? parsed.data : null;
  }

  /** Record cleanup separately so it can run while the project remains available. */
  sourceCleanup(id: string, next: z.infer<typeof sourceCleanup>, now: string): void {
    const updated = runChanges(this.orm.update(workspaceMoves).set({ ...next, updatedAt: now }).where(and(
      eq(workspaceMoves.id, id), eq(workspaceMoves.phase, "done"), eq(workspaceMoves.cleanup, "pending"),
    )));
    if (updated.changes !== 1) throw new Error("The retained source is no longer pending cleanup");
  }

  /** Commit an intent only if every live thread was covered by a reservation. */
  start(input: z.infer<typeof intent>, reservedIds: string[]): void {
    this.db.transaction(() => {
      const workspace = this.orm.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).get();
      if (workspace?.kind !== "no_project" || workspace.deletedAt !== null) {
        throw new Error("The No project workspace changed while preparing the move");
      }
      const reserved = new Set(reservedIds);
      const sharers = this.orm.select({ id: threads.id }).from(threads).where(and(
        eq(threads.workspaceId, input.workspaceId), isNull(threads.deletedAt),
      )).all();
      if (sharers.some(({ id }) => !reserved.has(id))) {
        throw new Error("A thread was created while preparing the move");
      }
      this.orm.insert(workspaceMoves).values({
        ...input, phase: "intent", revision: 1, cleanup: "done", updatedAt: input.createdAt,
      }).run();
    }).immediate();
  }

  /** Advance a receipt against its durable revision, including cleanup and recovery updates. */
  advance(id: string, revision: number, next: z.infer<typeof checkpoint>, now: string, git?: z.infer<typeof placement>): void {
    this.db.transaction(() => {
      const move = this.find(id);
      if (move?.revision !== revision) throw new Error("The workspace move changed before its checkpoint was recorded");
      if (git) {
        const project = runChanges(this.orm.update(workspaces).set({ isGitRepo: Number(git.isGitRepo), updatedAt: now }).where(and(
          eq(workspaces.id, move.workspaceId), eq(workspaces.path, move.destinationPath),
          eq(workspaces.kind, "project"), isNull(workspaces.deletedAt),
        )));
        if (project.changes !== 1) throw new Error("The converted project is no longer available");
        this.orm.update(threads).set({ branch: git.branch, updatedAt: now })
          .where(eq(threads.workspaceId, move.workspaceId)).run();
      }
      const { manifest, ...receipt } = next;
      if (manifest) this.orm.insert(workspaceMoveManifests).values({ moveId: id, entries: manifest }).run();
      this.orm.update(workspaceMoves).set({ ...receipt, revision: revision + 1, updatedAt: now })
        .where(eq(workspaceMoves.id, id)).run();
    }).immediate();
  }

  /** Change the workspace, all retained sharers, and the phase as one write. */
  convert(id: string, git: z.infer<typeof placement>, now: string) {
    return this.db.transaction(() => {
      const move = this.find(id);
      if (move?.phase !== "renamed" && move?.phase !== "published") throw new Error("The workspace move has not published its folder");
      const duplicate = this.orm.select({ id: workspaces.id }).from(workspaces).where(and(
        eq(workspaces.kind, "project"), isNull(workspaces.deletedAt), sql`lower(${workspaces.name}) = ${move.name.toLowerCase()}`,
      )).get();
      if (duplicate) throw new Error("A project with this name already exists");
      const converted = runChanges(this.orm.update(workspaces).set({
        kind: "project", path: move.destinationPath, name: move.name, isGitRepo: Number(git.isGitRepo),
        movedOutAt: null, retainUntil: null, updatedAt: now,
      }).where(and(eq(workspaces.id, move.workspaceId), eq(workspaces.kind, "no_project"), isNull(workspaces.deletedAt))));
      if (converted.changes !== 1) throw new Error("The No project workspace is no longer available");
      const results = new ThreadStore(this.db).convertWorkspaceSharers(move.workspaceId, move.name, git.branch, now);
      this.orm.update(workspaceMoves).set({ phase: "converted", revision: move.revision + 1, updatedAt: now })
        .where(eq(workspaceMoves.id, id)).run();
      return results;
    }).immediate();
  }
}

export function workspaceMoveWriteHandlers(db: Database) {
  const store = new WorkspaceMoveStore(db);
  return new Map<string, (input: unknown) => unknown>([
    [workspaceMoveWrites.start.name, databaseWriteHandler(workspaceMoveWrites.start, (args) => store.start(...args))],
    [workspaceMoveWrites.advance.name, databaseWriteHandler(workspaceMoveWrites.advance, (args) => store.advance(...args))],
    [workspaceMoveWrites.convert.name, databaseWriteHandler(workspaceMoveWrites.convert, (args) => store.convert(...args))],
    [workspaceMoveWrites.sourceCleanup.name, databaseWriteHandler(workspaceMoveWrites.sourceCleanup, (args) => store.sourceCleanup(...args))],
  ]);
}
