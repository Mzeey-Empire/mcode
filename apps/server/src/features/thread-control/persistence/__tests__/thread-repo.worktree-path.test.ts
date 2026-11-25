import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import * as push from "../../../../application/transport/push.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
import { ThreadRepo } from "../thread-repo.js";

async function setup() {
  const runtime = createThreadPersistenceTestRuntime();
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("Alpha", "/alpha");
  const thread = await threads.create(workspace.id, "Forked", "worktree", "main");
  const pushes: unknown[] = [];
  vi.spyOn(push, "broadcast").mockImplementation((channel, payload) => {
    if (channel === "thread.worktreeChanged") pushes.push({ payload, readable: threads.findById(thread.id)?.worktree_path });
  });
  return { threads, thread, pushes };
}

describe("ThreadRepo worktree path pushes", () => {
  it("tells clients a saved and then cleared worktree path after each is readable", async () => {
    const { threads, thread, pushes } = await setup();

    await threads.updateWorktreePath(thread.id, "/alpha-worktrees/fork");
    await threads.clearWorktreePath(thread.id);

    expect(pushes).toEqual([
      { payload: { threadId: thread.id, worktreePath: "/alpha-worktrees/fork" }, readable: "/alpha-worktrees/fork" },
      { payload: { threadId: thread.id, worktreePath: null }, readable: null },
    ]);
  });

  it("sends nothing when the save does not apply", async () => {
    const { threads, thread, pushes } = await setup();
    await threads.softDelete(thread.id);

    expect(await threads.updateWorktreePath(thread.id, "/alpha-worktrees/fork")).toBe(false);

    expect(pushes).toEqual([]);
  });
});
