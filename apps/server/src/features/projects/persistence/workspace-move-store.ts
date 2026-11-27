import type { Database } from "bun:sqlite";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { MessageSchema } from "@mcode/contracts/models/message";
import { ThreadSchema } from "@mcode/contracts/models/thread";
import { WorkspaceMovePhaseSchema, WorkspaceMoveResultSchema } from "@mcode/contracts/ws/workspace-move";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";
import { threads, workspaceMoves, workspaces } from "../../../runtime/persistence/sqlite/schema.js";
import { ThreadStore } from "../../thread-control/persistence/thread-store.js";

/** A durable move at the last committed checkpoint. */
export type WorkspaceMove = typeof workspaceMoves.$inferSelect;

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
  phase: WorkspaceMovePhaseSchema(),
  result: WorkspaceMoveResultSchema().nullable(),
  cleanup: z.enum(["done", "pending", "kept"]),
  error: z.string().nullable(),
});
const placement = z.object({
  isGitRepo: z.boolean(), branch: z.string(),
});
const convertedThread = z.object({ thread: ThreadSchema(), marker: MessageSchema() });

/** Writer operations for the transaction and the checkpoints around filesystem work. */
export const workspaceMoveWrites = {
  start: databaseWriteOperation("workspace.move.start", z.tuple([intent, z.array(z.string())]), z.void()),
  advance: databaseWriteOperation("workspace.move.advance", z.tuple([
    z.string(), z.number().int(), checkpoint, z.string().datetime(), placement.optional(),
  ]), z.void()),
  convert: databaseWriteOperation("workspace.move.convert", z.tuple([
    z.string(), placement, z.string().datetime(),
  ]), z.array(convertedThread)),
};

/** Active moves must remain fenced even after the in-process lease is gone. */
export function unfinishedWorkspaceMove(workspaceId: typeof workspaces.id | string) {
  return and(eq(workspaceMoves.workspaceId, workspaceId), ne(workspaceMoves.phase, "done"));
}

/** Reads move state and runs the workspace conversion on the SQLite writer. */
export class WorkspaceMoveStore {
  private readonly orm;

  constructor(private readonly db: Database) {
    this.orm = drizzle(db);
  }

  /** Read a retained operation receipt by ID. */
  find(id: string): WorkspaceMove | null {
    return this.orm.select().from(workspaceMoves).where(eq(workspaceMoves.id, id)).get() ?? null;
  }

  /** Find the current fence for a workspace. */
  findUnfinished(workspaceId: string): WorkspaceMove | null {
    return this.orm.select().from(workspaceMoves).where(unfinishedWorkspaceMove(workspaceId)).get() ?? null;
  }

  /** Find the rows that startup must reconcile. */
  listRecoverable(): WorkspaceMove[] {
    return this.orm.select().from(workspaceMoves).where(sql`
      ${workspaceMoves.phase} <> 'done' OR ${workspaceMoves.cleanup} = 'pending'
    `).all();
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
      this.orm.update(workspaceMoves).set({ ...next, revision: revision + 1, updatedAt: now })
        .where(eq(workspaceMoves.id, id)).run();
    }).immediate();
  }

  /** Change the workspace, all retained sharers, and the phase as one write. */
  convert(id: string, git: z.infer<typeof placement>, now: string) {
    return this.db.transaction(() => {
      const move = this.find(id);
      if (move?.phase !== "renamed") throw new Error("The workspace move has not finished its rename");
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

/** Bind the move transactions to the application database writer. */
export function workspaceMoveWriteHandlers(db: Database) {
  const store = new WorkspaceMoveStore(db);
  return new Map<string, (input: unknown) => unknown>([
    [workspaceMoveWrites.start.name, databaseWriteHandler(workspaceMoveWrites.start, (args) => store.start(...args))],
    [workspaceMoveWrites.advance.name, databaseWriteHandler(workspaceMoveWrites.advance, (args) => store.advance(...args))],
    [workspaceMoveWrites.convert.name, databaseWriteHandler(workspaceMoveWrites.convert, (args) => store.convert(...args))],
  ]);
}
