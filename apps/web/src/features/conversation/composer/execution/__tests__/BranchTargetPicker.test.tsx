import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  DetachedWorktreeTarget,
  GitRef,
  GitRefsListParams,
  GitRefsListResult,
  PullRequestTarget,
  PullRequestTargetsListParams,
  PullRequestTargetsListResult,
} from "@mcode/contracts";

import { mockTransport } from "@/__tests__/mocks/transport";
import { installListboxLayout, scrollListTo } from "@/__tests__/helpers/picker-layout";
import { BranchTargetPicker, type BranchTargetPickerProps } from "../BranchTargetPicker";
import { invalidateBranchTargets, useDefaultBranchTarget } from "../targets/useBranchTargets";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

installListboxLayout();

const REF_PAGE = 50;
const PR_PAGE = 30;
const CURRENT_WORKTREE = { path: "C:\\repo\\.worktrees\\current", folder: "current" };
const REVIEW_WORKTREE = { path: "C:\\repo\\.worktrees\\review", folder: "review" };

function ref(shortName: string, overrides: Partial<GitRef> = {}): GitRef {
  return {
    kind: "ref",
    fullName: `refs/heads/${shortName}`,
    shortName,
    branchName: shortName,
    remote: null,
    twin: null,
    isCurrent: false,
    isDefault: false,
    worktree: null,
    headSha: "a".repeat(40),
    committedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function pullRequest(number: number, title: string, headRefName: string): PullRequestTarget {
  return { number, title, headRefName, author: "octo", isCrossRepository: false, url: `https://github.com/acme/app/pull/${number}` };
}

const REFS: readonly GitRef[] = [
  ref("main", { isDefault: true }),
  ref("feature/current", { isCurrent: true, worktree: CURRENT_WORKTREE }),
  ref("feature/sidebar-resize"),
  ref("feature/sidebar-collapse"),
  ...Array.from({ length: 116 }, (_, index) => ref(`feature/topic-${String(index + 4).padStart(3, "0")}`)),
];

const WORKTREE_TARGETS: readonly (GitRef | DetachedWorktreeTarget)[] = [
  ref("feature/current", { worktree: CURRENT_WORKTREE }),
  { kind: "detached-worktree", worktree: REVIEW_WORKTREE, headShortSha: "abc1234" },
];

const PULL_REQUESTS: readonly PullRequestTarget[] = [
  pullRequest(1804, "Resize the sidebar", "feat/sidebar-resize"),
  pullRequest(1805, "Collapse the sidebar", "feat/sidebar-collapse"),
  pullRequest(1806, "Guard feature flags", "fix/feature-flags"),
];

let refSource: readonly (GitRef | DetachedWorktreeTarget)[] = REFS;
let pullRequestSource: readonly PullRequestTarget[] = PULL_REQUESTS;

function refPage(params: GitRefsListParams): GitRefsListResult {
  const source = params.purpose === "existing-worktree" ? WORKTREE_TARGETS : refSource;
  const query = params.query ?? "";
  const matches = source.filter((target) => (target.kind === "ref" ? target.shortName : target.worktree.folder).includes(query));
  return page(matches, params.cursor, REF_PAGE);
}

function pullRequestPage(params: PullRequestTargetsListParams): PullRequestTargetsListResult {
  const query = params.query ?? "";
  const matches = pullRequestSource.filter((pr) => pr.title.includes(query) || pr.headRefName.includes(query));
  return page(matches, params.cursor, PR_PAGE);
}

function page<T>(matches: readonly T[], cursor: string | undefined, size: number) {
  const offset = Number(cursor ?? 0);
  const items = matches.slice(offset, offset + size);
  const next = offset + items.length;
  return { ok: true as const, items, total: matches.length, nextCursor: next < matches.length ? String(next) : null };
}

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Holds the next `listRefs` call until the returned gate opens, then answers it from the fake source. */
function holdNextRefPage(): Gate {
  const held = gate();
  vi.mocked(mockTransport.listRefs).mockImplementationOnce(async (params) => {
    await held.promise;
    return refPage(params);
  });
  return held;
}

const listRefs = () => vi.mocked(mockTransport.listRefs);
const listPullRequests = () => vi.mocked(mockTransport.listPullRequestTargets);
const refCalls = () => listRefs().mock.calls.map(([params]) => ({ query: params.query, cursor: params.cursor }));

let workspaceCount = 0;
let workspaceId = "";

beforeEach(() => {
  workspaceCount += 1;
  workspaceId = `ws-${workspaceCount}`;
  refSource = REFS;
  pullRequestSource = PULL_REQUESTS;
  listRefs().mockReset().mockImplementation(async (params) => refPage(params));
  listPullRequests().mockReset().mockImplementation(async (params) => pullRequestPage(params));
});

function renderPicker(props: Partial<BranchTargetPickerProps> = {}) {
  const onSelect = vi.fn();
  const view = render(
    <BranchTargetPicker workspaceId={workspaceId} list="branches" value={null} onSelect={onSelect} {...props} />,
  );
  return { ...view, onSelect };
}

function search(query: string) {
  fireEvent.change(screen.getByRole("combobox"), { target: { value: query } });
}

/** Each listed row's text: options in full, group labels in brackets. */
function listedRows(): string[] {
  return [...screen.getByRole("listbox").children].flatMap((child) => {
    if (child.getAttribute("data-slot") === "picker-group-label") return [`[${child.textContent}]`];
    return child.getAttribute("role") === "option" ? [child.textContent ?? ""] : [];
  });
}

function option(name: string): HTMLElement {
  const row = screen.getByText(name, { selector: "[role=option] span" }).closest<HTMLElement>("[role=option]");
  if (!row) throw new Error(`No option named ${name}`);
  return row;
}

describe("BranchTargetPicker", () => {
  it("pages to the end of the list without a spinner row, one request per page", async () => {
    renderPicker();
    expect(await screen.findByText("Showing 50 of 120")).toBeInTheDocument();
    const pageTwo = holdNextRefPage();
    scrollListTo(0);
    scrollListTo(0);
    expect(refCalls()).toEqual([
      { query: undefined, cursor: undefined },
      { query: undefined, cursor: "50" },
    ]);
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    await act(async () => pageTwo.open());
    expect(await screen.findByText("Showing 100 of 120")).toBeInTheDocument();
    scrollListTo(0);
    expect(await screen.findByText("Showing 120 of 120")).toBeInTheDocument();
    scrollListTo(0);
    expect(refCalls().map((call) => call.cursor)).toEqual([undefined, "50", "100"]);
  });

  it("waits for typing to settle before searching, and shows the full list again at once when cleared", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    renderPicker();
    await act(async () => {});
    expect(screen.getByText("Showing 50 of 120")).toBeInTheDocument();
    search("s");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    search("si");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    search("sid");
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(refCalls()).toEqual([{ query: undefined, cursor: undefined }]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(refCalls()).toEqual([
      { query: undefined, cursor: undefined },
      { query: "sid", cursor: undefined },
    ]);
    expect(screen.getByText("Showing 2 of 2")).toBeInTheDocument();
    search("");
    expect(screen.getByText("Showing 50 of 120")).toBeInTheDocument();
    expect(listRefs()).toHaveBeenCalledTimes(2);
  });

  it("keeps the last rows on screen while a new query loads, and drops a response that lands after the query moved on", async () => {
    renderPicker();
    await screen.findByText("Showing 50 of 120");
    const sidebar = holdNextRefPage();
    const collapse = holdNextRefPage();
    search("sidebar");
    await waitFor(() => expect(listRefs()).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole("option")).toHaveLength(50);
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    search("sidebar-c");
    await waitFor(() => expect(listRefs()).toHaveBeenCalledTimes(3));
    await act(async () => collapse.open());
    expect(await screen.findByText("Showing 1 of 1")).toBeInTheDocument();
    await act(async () => sidebar.open());
    expect(listedRows()).toEqual(["feature/sidebar-collapse"]);
    expect(screen.getByText("Showing 1 of 1")).toBeInTheDocument();
    expect(refCalls().slice(1)).toEqual([
      { query: "sidebar", cursor: undefined },
      { query: "sidebar-c", cursor: undefined },
    ]);
  });

  it("shows a failed first page with its git detail, then lists the branches when Retry succeeds", async () => {
    listRefs().mockResolvedValueOnce({
      ok: false,
      error: { code: "git_failed", message: "git for-each-ref failed", detail: "fatal: bad object refs/heads/broken" },
    });
    renderPicker({ list: "branches-and-pull-requests", footer: <span>Start from origin</span> });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn't list branches")).toBeInTheDocument();
    expect(within(alert).getByText("fatal: bad object refs/heads/broken")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    expect(screen.queryByText("Start from origin")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Pull requests" })).toBeEnabled();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Showing 50 of 120")).toBeInTheDocument();
    expect(refCalls().map((call) => call.cursor)).toEqual([undefined, undefined]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Start from origin")).toBeInTheDocument();
  });

  it("keeps the loaded rows when a later page fails, and Retry asks for that page again", async () => {
    renderPicker();
    await screen.findByText("Showing 50 of 120");
    listRefs().mockResolvedValueOnce({ ok: false, error: { code: "timed_out", message: "git timed out" } });
    scrollListTo(0);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("git timed out")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(50);
    expect(screen.getByText("Showing 50 of 120")).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Showing 100 of 120")).toBeInTheDocument();
    expect(refCalls().map((call) => call.cursor)).toEqual([undefined, "50", "50"]);
  });

  it("restarts pull requests from the first page when GitHub rejects an expired cursor, then pages on", async () => {
    pullRequestSource = Array.from({ length: 35 }, (_, index) => pullRequest(2000 + index, `Change ${index}`, `change-${index}`));
    renderPicker({ list: "branches-and-pull-requests" });
    fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
    expect(await screen.findByText("Showing 30 of 35")).toBeInTheDocument();
    listPullRequests().mockResolvedValueOnce({ ok: false, error: { code: "stale_cursor", message: "Cursor expired" } });
    scrollListTo(0);
    expect(await screen.findByText("Showing 35 of 35")).toBeInTheDocument();
    expect(listPullRequests().mock.calls.map(([params]) => params.cursor)).toEqual([undefined, "30", undefined, "30"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refetches the first page when the workspace's branches change", async () => {
    renderPicker();
    await screen.findByText("Showing 50 of 120");
    expect(within(option("feature/current")).getByText("current")).toBeInTheDocument();
    refSource = REFS.map((target) => ({ ...target, isCurrent: target.shortName === "main" }));
    act(() => {
      invalidateBranchTargets(workspaceId);
    });
    await waitFor(() => expect(within(option("main")).getByText("current")).toBeInTheDocument());
    expect(within(option("feature/current")).getByText("worktree")).toBeInTheDocument();
    expect(refCalls().map((call) => call.cursor)).toEqual([undefined, undefined]);
  });

  it("refetches the first page each time it opens while showing the cached rows at once", async () => {
    const first = renderPicker();
    await screen.findByText("Showing 50 of 120");
    first.unmount();
    const fresh = holdNextRefPage();
    renderPicker();
    expect(screen.getByText("Showing 50 of 120")).toBeInTheDocument();
    expect(refCalls().map((call) => call.cursor)).toEqual([undefined, undefined]);
    await act(async () => fresh.open());
    expect(screen.getAllByRole("option")).toHaveLength(50);
  });

  it("lists matching pull requests under the branches only once every matching branch has loaded", async () => {
    renderPicker({ list: "branches-and-pull-requests" });
    await screen.findByText("Showing 50 of 120");
    search("feature");
    expect(await screen.findByText("Showing 50 of 119")).toBeInTheDocument();
    await waitFor(() => expect(listPullRequests()).toHaveBeenCalledWith(expect.objectContaining({ query: "feature" })));
    expect(screen.queryByText("Guard feature flags")).not.toBeInTheDocument();
    scrollListTo(0);
    expect(await screen.findByText("Showing 100 of 119")).toBeInTheDocument();
    expect(screen.queryByText("Guard feature flags")).not.toBeInTheDocument();
    scrollListTo(0);
    expect(await screen.findByText("Showing 120 of 120")).toBeInTheDocument();
    expect(listedRows().slice(-3)).toEqual([
      "feature/topic-119",
      "[Pull requests]",
      "Guard feature flags#1806 · fix/feature-flags",
    ]);
  });

  it("groups pull requests matching a branch search under a label", async () => {
    renderPicker({ list: "branches-and-pull-requests" });
    await screen.findByText("Showing 50 of 120");
    search("sidebar");
    expect(await screen.findByText("Showing 4 of 4")).toBeInTheDocument();
    expect(listedRows()).toEqual([
      "feature/sidebar-resize",
      "feature/sidebar-collapse",
      "[Pull requests]",
      "Resize the sidebar#1804 · feat/sidebar-resize",
      "Collapse the sidebar#1805 · feat/sidebar-collapse",
    ]);
  });

  it("drops the pull request group from a branch search when GitHub fails, and shows the failure on the Pull requests tab", async () => {
    listPullRequests().mockResolvedValue({ ok: false, error: { code: "unauthenticated", message: "Sign in to GitHub" } });
    renderPicker({ list: "branches-and-pull-requests" });
    await screen.findByText("Showing 50 of 120");
    search("sidebar");
    await waitFor(() => expect(listPullRequests()).toHaveBeenCalled());
    expect(await screen.findByText("Showing 2 of 2")).toBeInTheDocument();
    expect(listedRows()).toEqual(["feature/sidebar-resize", "feature/sidebar-collapse"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn't list pull requests")).toBeInTheDocument();
    expect(within(alert).getByText("Sign in to GitHub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Branches" }));
    expect(listedRows()).toEqual(["feature/sidebar-resize", "feature/sidebar-collapse"]);
  });

  it("offers the Pull requests tab only for a new worktree", async () => {
    const branches = renderPicker({ list: "branches" });
    await screen.findByText("Showing 50 of 120");
    expect(screen.queryByRole("radio", { name: "Pull requests" })).not.toBeInTheDocument();
    branches.unmount();
    renderPicker({ list: "worktrees" });
    await screen.findByText("Showing 2 of 2");
    expect(screen.queryByRole("radio", { name: "Pull requests" })).not.toBeInTheDocument();
    expect(listPullRequests()).not.toHaveBeenCalled();
  });

  it("fills the selected row and hands back the picked branch or pull request", async () => {
    const { onSelect } = renderPicker({
      list: "branches-and-pull-requests",
      value: { kind: "branch", name: "feature/current" },
    });
    await screen.findByText("Showing 50 of 120");
    expect(option("feature/current")).toHaveAttribute("aria-selected", "true");
    expect(option("feature/current")).toHaveAttribute("data-selected", "true");
    expect(option("main")).toHaveAttribute("aria-selected", "false");
    fireEvent.click(option("main"));
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "branch",
      name: "main",
      branchName: "main",
      remote: null,
      twin: null,
      isCurrent: false,
      isDefault: true,
      worktree: null,
    });
    fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
    await screen.findByText("Showing 3 of 3");
    fireEvent.click(option("Resize the sidebar"));
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "pull-request",
      number: 1804,
      title: "Resize the sidebar",
      headRefName: "feat/sidebar-resize",
    });
  });

  it("dims a row the host rules out and says why", async () => {
    const { onSelect } = renderPicker({
      disabledReason: (target) => (target.kind === "branch" && target.name === "main" ? "Head branch" : undefined),
    });
    await screen.findByText("Showing 50 of 120");
    expect(option("main")).toHaveAttribute("aria-disabled", "true");
    expect(option("main")).toHaveAccessibleDescription("Head branch");
    fireEvent.click(option("main"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("lists linked worktrees by folder from the main checkout and hands back the picked checkout", async () => {
    const { onSelect } = renderPicker({
      list: "worktrees",
      threadId: "thread-1",
      value: { kind: "worktree", path: "c:/repo/.worktrees/current/" },
    });
    await screen.findByText("Showing 2 of 2");
    expect(listRefs()).toHaveBeenCalledWith({
      workspaceId,
      threadId: undefined,
      purpose: "existing-worktree",
      query: undefined,
      cursor: undefined,
    });
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "Search worktrees");
    expect(listedRows()).toEqual(["currentfeature/current", "reviewabc1234"]);
    expect(option("current")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(option("review"));
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "detached-worktree",
      worktree: REVIEW_WORKTREE,
      headShortSha: "abc1234",
    });
  });

  it("shows the footer under Branches but not under Pull requests", async () => {
    renderPicker({ list: "branches-and-pull-requests", footer: <span>Start from origin</span> });
    await screen.findByText("Showing 50 of 120");
    expect(screen.getByText("Start from origin")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
    await screen.findByText("Showing 3 of 3");
    expect(screen.queryByText("Start from origin")).not.toBeInTheDocument();
  });
});

describe("useDefaultBranchTarget", () => {
  it("is unknown while the first page loads, then the checked-out branch", async () => {
    const pageOne = holdNextRefPage();
    const { result } = renderHook(() => useDefaultBranchTarget({ workspaceId }));
    expect(result.current).toBeUndefined();
    await act(async () => pageOne.open());
    expect(result.current?.name).toBe("feature/current");
  });

  it("falls back to the repository default when no branch is checked out", async () => {
    refSource = REFS.map((target) => ({ ...target, isCurrent: false }));
    const { result } = renderHook(() => useDefaultBranchTarget({ workspaceId }));
    await waitFor(() => expect(result.current?.name).toBe("main"));
  });

  it("is null when the first page failed", async () => {
    listRefs().mockResolvedValueOnce({ ok: false, error: { code: "not_a_repository", message: "Not a git repository" } });
    const { result } = renderHook(() => useDefaultBranchTarget({ workspaceId }));
    await waitFor(() => expect(result.current).toBeNull());
  });
});
