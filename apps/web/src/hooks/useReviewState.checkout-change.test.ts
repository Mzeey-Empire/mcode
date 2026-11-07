// @vitest-environment jsdom
import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, renderHook } from "@testing-library/react";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "@mcode/contracts/models/review-comparison";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { pushEmitter } from "@/transport/ws-transport";
import { useReviewState } from "./useReviewState";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const getReviewState = vi.mocked(mockTransport.getReviewState);
const WORKSPACE = "workspace-checkout-change";
const IS_WINDOWS = hostRuntime.platform === "win32";
let repo = "";
let otherRepo = "";
let junctionParent = "";
let junction = "";

function git(cwd: string, ...args: string[]): string {
  return NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(prefix: string): string {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  NodeChildProcess.execFileSync("git", ["-c", "init.defaultBranch=main", "init", dir]);
  git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "init");
  git(dir, "branch", "feature");
  return dir;
}

/** The directory the server reads for a scope: a worktree thread's own path, otherwise the workspace root. */
function checkoutOf(workspaceId: string, threadId: string | undefined): string {
  const { threads, workspaces } = useWorkspaceStore.getState();
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (thread?.mode === "worktree" && thread.worktree_path) return thread.worktree_path;
  return workspaces.find((workspace) => workspace.id === workspaceId)?.path ?? repo;
}

/**
 * Answers each request with the branch checked out, through the scope's own
 * path, when the request starts, and holds the answer until `release`, the
 * way a slow server probe reads git before the reply reaches the client.
 */
function delayedProbes() {
  const pending: Array<() => void> = [];
  getReviewState.mockImplementation((workspaceId, threadId) => {
    const cwd = checkoutOf(workspaceId, threadId);
    const state: ReviewState = {
      isGitRepo: true, head: git(cwd, "rev-parse", "HEAD"), branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
      uncommitted: { staged: 0, unstaged: 0, untracked: 0 }, commitsAhead: null, branchDefault: { unavailable: "no-base" },
    };
    return new Promise((resolve) => { pending.push(() => resolve(state)); });
  });
  return { release: async () => { await act(async () => { for (const finish of pending.splice(0)) finish(); }); } };
}

/** Let the frame that gathers checkout events end. */
async function endFrame(): Promise<void> {
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
}

function branchesOf(hooks: ReadonlyArray<ReturnType<typeof useReviewState>>): Array<string | null> {
  return hooks.map((hook) => (hook.state?.isGitRepo ? hook.state.branch : null));
}

beforeAll(() => {
  repo = initRepo("mcode-review-checkout-");
  otherRepo = initRepo("mcode-review-other-");
  if (!IS_WINDOWS) return;
  junctionParent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-junction-"));
  junction = NodePath.join(junctionParent, "checkout");
  NodeChildProcess.execFileSync("cmd", ["/c", "mklink", "/J", junction, repo]);
});
afterAll(() => {
  // Remove the junction itself first: a recursive delete through it would empty the repo it points at.
  if (junction) NodeChildProcess.execFileSync("cmd", ["/c", "rmdir", junction]);
  if (junctionParent) NodeFS.rmSync(junctionParent, { recursive: true, force: true });
  NodeFS.rmSync(repo, { recursive: true, force: true });
  NodeFS.rmSync(otherRepo, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  getReviewState.mockReset();
  useDiffStore.setState({ diffRevisionByScope: {} });
  startPushListeners();
});
afterEach(() => {
  stopPushListeners();
  vi.useRealTimers();
  git(repo, "checkout", "--quiet", "main");
});

// A request that started before HEAD moved answers for the old HEAD, so no
// reader may join it once the server reports the move, and no mounted reader
// may keep its answer.
describe("useReviewState after a checkout change", () => {
  it("does not hand a reader that mounts after a branch switch the read started before it", async () => {
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: WORKSPACE, path: repo })],
      threads: [
        createMockThread({ id: "direct-a", workspace_id: WORKSPACE, mode: "direct", worktree_path: null }),
        createMockThread({ id: "direct-b", workspace_id: WORKSPACE, mode: "direct", worktree_path: null }),
      ],
    });
    const probes = delayedProbes();
    const away = renderHook(() => useReviewState(WORKSPACE, "direct-a"));
    away.unmount();

    git(repo, "checkout", "--quiet", "feature");
    act(() => pushEmitter.emit("branch.changed", { workspaceId: WORKSPACE, branch: "feature" }));
    const back = renderHook(() => [useReviewState(WORKSPACE, "direct-a"), useReviewState(WORKSPACE, "direct-b")]);
    await probes.release();

    expect(branchesOf(back.result.current)).toEqual(["feature", "feature"]);
  });

  // The server resolves a checkout's real path, but the client only has the
  // path text each thread was opened with. Junctions give one directory two
  // texts, so text matching cannot tell this reader shares the moved checkout.
  it.skipIf(!IS_WINDOWS)("does not hand a reader that reaches the checkout through a junction a read from before a branch switch", async () => {
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: WORKSPACE, path: repo })],
      threads: [createMockThread({ id: "via-junction", workspace_id: WORKSPACE, mode: "worktree", worktree_path: junction })],
    });
    const probes = delayedProbes();
    const away = renderHook(() => useReviewState(WORKSPACE, "via-junction"));
    away.unmount();

    git(repo, "checkout", "--quiet", "feature");
    act(() => pushEmitter.emit("branch.changed", { workspaceId: WORKSPACE, branch: "feature" }));
    const back = renderHook(() => useReviewState(WORKSPACE, "via-junction"));
    await probes.release();

    expect(back.result.current.state).toMatchObject({ branch: "feature" });
    expect(getReviewState).toHaveBeenCalledTimes(2);
  });

  it("re-reads every mounted reader once after HEAD moves, each from its own checkout", async () => {
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: WORKSPACE, path: NodePath.join(repo, "..", "elsewhere") })],
      threads: [
        createMockThread({ id: "worktree-a", workspace_id: WORKSPACE, mode: "worktree", worktree_path: repo }),
        createMockThread({ id: "worktree-b", workspace_id: WORKSPACE, mode: "worktree", worktree_path: `${repo}/` }),
        createMockThread({ id: "other", workspace_id: WORKSPACE, mode: "worktree", worktree_path: otherRepo }),
      ],
    });
    const probes = delayedProbes();
    const readers = renderHook(() => [useReviewState(WORKSPACE, "worktree-b"), useReviewState(WORKSPACE, "other")]);
    await probes.release();
    expect(branchesOf(readers.result.current)).toEqual(["main", "main"]);

    git(repo, "checkout", "--quiet", "feature");
    act(() => pushEmitter.emit("thread.checkoutChanged", {
      threadId: "worktree-a", workspaceId: WORKSPACE, branch: "feature", checkoutState: "named", baseBranch: null, headSha: null,
    }));
    await endFrame();
    await probes.release();

    expect(branchesOf(readers.result.current)).toEqual(["feature", "main"]);
    expect(getReviewState.mock.calls).toEqual([
      [WORKSPACE, "worktree-b"], [WORKSPACE, "other"], [WORKSPACE, "worktree-b"], [WORKSPACE, "other"],
    ]);
  });

  // A rebase moves HEAD many times, and threads sharing a worktree each have
  // a server watcher, so one change can arrive as many separate messages.
  it("re-reads once for a burst of checkout events within one frame", async () => {
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: WORKSPACE, path: repo })],
      threads: [createMockThread({ id: "direct-a", workspace_id: WORKSPACE, mode: "direct", worktree_path: null })],
    });
    const probes = delayedProbes();
    const reader = renderHook(() => useReviewState(WORKSPACE, "direct-a"));
    await probes.release();

    git(repo, "checkout", "--quiet", "feature");
    for (let message = 0; message < 20; message += 1) {
      await act(async () => {
        pushEmitter.emit("branch.changed", { workspaceId: WORKSPACE, branch: "feature" });
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    await endFrame();
    await probes.release();

    expect(reader.result.current.state).toMatchObject({ branch: "feature" });
    expect(getReviewState).toHaveBeenCalledTimes(2);
  });
});
