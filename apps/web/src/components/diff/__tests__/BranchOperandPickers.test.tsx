// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchComparison, GitRef, GitRefsListParams, GitRefsListResult } from "@mcode/contracts";

import { mockTransport } from "@/__tests__/mocks/transport";
import { installListboxLayout } from "@/__tests__/helpers/picker-layout";
import { effectiveBranchOperands, useDiffStore } from "@/stores/diffStore";
import { BranchOperandPickers } from "../BranchOperandPickers";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

installListboxLayout();

function ref(fullName: string, overrides: Partial<GitRef> = {}): GitRef {
  const remote = /^refs\/remotes\/([^/]+)\//.exec(fullName)?.[1] ?? null;
  const branchName = fullName.replace(/^refs\/(heads|remotes\/[^/]+)\//, "");
  return {
    kind: "ref",
    fullName,
    shortName: remote ? `${remote}/${branchName}` : branchName,
    branchName,
    remote,
    twin: null,
    isCurrent: false,
    isDefault: false,
    worktree: null,
    headSha: "a".repeat(40),
    committedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

const LOCAL: readonly GitRef[] = [
  ref("refs/heads/main", { isDefault: true }),
  ref("refs/heads/mcode-3f2a", { isCurrent: true, worktree: { path: "C:\\repo\\.worktrees\\mcode-3f2a", folder: "mcode-3f2a" } }),
  ...Array.from({ length: 148 }, (_, index) => ref(`refs/heads/topic-${String(index).padStart(3, "0")}`)),
];
const ORIGIN: readonly GitRef[] = [
  ref("refs/remotes/origin/main", { isDefault: true, headSha: "b".repeat(40) }),
  ref("refs/remotes/origin/release"),
  ref("refs/remotes/upstream/main"),
];

let failNextList = false;
let originRefs: readonly GitRef[] = ORIGIN;

function refPage(params: GitRefsListParams): GitRefsListResult {
  if (failNextList) {
    failNextList = false;
    return { ok: false, error: { code: "git_failed", message: "git for-each-ref failed", detail: "fatal: bad object" } };
  }
  const source = params.side === "origin" ? originRefs : LOCAL;
  const query = params.query ?? "";
  const matches = source.filter((target) => target.shortName.includes(query));
  const offset = Number(params.cursor ?? 0);
  const items = matches.slice(offset, offset + (params.limit ?? 100));
  const next = offset + items.length;
  return { ok: true, items, total: matches.length, nextCursor: next < matches.length ? String(next) : null };
}

const DEFAULT_COMPARISON: BranchComparison = {
  base: "refs/remotes/origin/main",
  compare: "refs/heads/mcode-3f2a",
  isUnborn: false,
  isComparisonAvailable: true,
};

let workspaceCount = 0;
let workspaceId = "";
const scope = () => `${workspaceId}:thread-1`;

beforeEach(() => {
  workspaceCount += 1;
  workspaceId = `ws-${workspaceCount}`;
  failNextList = false;
  originRefs = ORIGIN;
  vi.mocked(mockTransport.listRefs).mockReset().mockImplementation(async (params) => refPage(params));
  vi.mocked(mockTransport.getBranchComparison).mockReset().mockResolvedValue(DEFAULT_COMPARISON);
  useDiffStore.setState({
    branchComparison: null,
    branchComparisonKey: null,
    branchSelectionByScope: {},
    branchResolvedRevisionByScope: {},
  });
});

async function renderPickers() {
  render(<BranchOperandPickers workspaceId={workspaceId} threadId="thread-1" diffScopeRevision={0} />);
  await screen.findByTestId("branch-operand-pickers");
}

async function open(side: "base" | "compare") {
  fireEvent.click(screen.getByTestId(`branch-${side}-picker`));
  await screen.findByRole("listbox");
}

function showTab(name: "Local" | "Origin") {
  fireEvent.click(screen.getByRole("radio", { name }));
}

function option(name: string): HTMLElement {
  return screen.getByRole("option", { name });
}

function listedNames(): string[] {
  return screen.getAllByRole("option").map((row) => row.textContent ?? "");
}

function storedOperands() {
  const state = useDiffStore.getState();
  return effectiveBranchOperands(state.branchComparison, state.branchSelectionByScope[scope()]);
}

describe("BranchOperandPickers", () => {
  it("opens base on Origin and compare on Local", async () => {
    await renderPickers();
    await open("base");
    expect(screen.getByRole("radio", { name: "Origin" })).toBeChecked();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    await open("compare");
    expect(screen.getByRole("radio", { name: "Local" })).toBeChecked();
  });

  it("shows the resolved default as compare → base", async () => {
    await renderPickers();
    expect(screen.getByTestId("branch-compare-picker")).toHaveTextContent("mcode-3f2a");
    expect(screen.getByTestId("branch-base-picker")).toHaveTextContent("origin/main");
  });

  it("lists diverged main and origin/main as separate rows, both named main, in the order served", async () => {
    await renderPickers();
    await open("compare");
    showTab("Local");
    expect(await screen.findByText("Showing 100 of 150")).toBeInTheDocument();
    expect(listedNames().slice(0, 3)).toEqual(["main", "mcode-3f2a", "topic-000"]);
    showTab("Origin");
    await waitFor(() => expect(listedNames()).toEqual(["main", "release", "upstream/main"]));
    expect(vi.mocked(mockTransport.listRefs)).toHaveBeenLastCalledWith(
      expect.objectContaining({ purpose: "review", side: "origin", workspaceId, threadId: "thread-1" }),
    );
  });

  it("stores origin/main as compare and mcode-3f2a as base, each picked on its own side", async () => {
    await renderPickers();
    await open("compare");
    showTab("Origin");
    await waitFor(() => expect(listedNames()).toContain("release"));
    fireEvent.click(option("main"));
    await waitFor(() => expect(screen.getByTestId("branch-compare-picker")).toHaveTextContent("origin/main"));

    await open("base");
    showTab("Local");
    await waitFor(() => expect(listedNames()).toContain("mcode-3f2a"));
    fireEvent.click(option("mcode-3f2a"));

    await waitFor(() => expect(storedOperands()).toEqual({
      base: "refs/heads/mcode-3f2a",
      compare: "refs/remotes/origin/main",
    }));
    expect(screen.getByTestId("branch-base-picker")).toHaveTextContent("mcode-3f2a");
  });

  it("offers the other tab in one click when the open tab has no match", async () => {
    await renderPickers();
    await open("compare");
    showTab("Local");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "release" } });
    const switchButton = await screen.findByRole("button", { name: "Show 1 in Origin" });
    fireEvent.click(switchButton);
    await waitFor(() => expect(listedNames()).toEqual(["release"]));
    expect(screen.getByRole("radio", { name: "Origin" })).toBeChecked();
  });

  it("shows an error row when the listing fails, and lists the refs after Retry", async () => {
    failNextList = true;
    await renderPickers();
    fireEvent.click(screen.getByTestId("branch-compare-picker"));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn't load the list")).toBeInTheDocument();
    expect(within(alert).getByText("git for-each-ref failed")).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listedNames()[0]).toBe("main"));
  });

  it("offers the other tab when the open tab is empty before any search", async () => {
    originRefs = [];
    await renderPickers();
    await open("base");
    showTab("Origin");
    fireEvent.click(await screen.findByRole("button", { name: "Show 150 in Local" }));
    await waitFor(() => expect(listedNames()).toContain("mcode-3f2a"));
    expect(screen.getByRole("radio", { name: "Local" })).toBeChecked();
  });

  it("names the selected refs to assistive tech", async () => {
    await renderPickers();
    expect(screen.getByRole("button", { name: "Compare: mcode-3f2a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Base: origin/main" })).toBeInTheDocument();
  });

  it("restores a branchless HEAD after another compare ref was picked", async () => {
    vi.mocked(mockTransport.getBranchComparison).mockResolvedValue({
      base: "refs/heads/main",
      compare: "HEAD",
      isUnborn: false,
      isComparisonAvailable: true,
    });
    await renderPickers();
    await open("compare");
    expect(screen.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();
    showTab("Local");
    await waitFor(() => expect(listedNames()).toContain("topic-000"));
    fireEvent.click(option("topic-000"));
    await waitFor(() => expect(storedOperands()).toEqual({ base: "refs/heads/main", compare: "refs/heads/topic-000" }));

    await open("compare");
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    await waitFor(() => expect(screen.getByTestId("branch-compare-picker")).toHaveTextContent("HEAD"));
    expect(storedOperands()).toEqual({ base: "refs/heads/main", compare: "HEAD" });
    expect(useDiffStore.getState().branchSelectionByScope[scope()]).toBeUndefined();
  });

  it("reads HEAD as a branchless compare, with the saved base as base", async () => {
    vi.mocked(mockTransport.getBranchComparison).mockResolvedValue({
      base: "refs/heads/release",
      compare: "HEAD",
      isUnborn: false,
      isComparisonAvailable: true,
    });
    await renderPickers();
    expect(screen.getByTestId("branch-compare-picker")).toHaveTextContent("HEAD");
    expect(screen.getByTestId("branch-base-picker")).toHaveTextContent("release");
    expect(storedOperands()).toEqual({ base: "refs/heads/release", compare: "HEAD" });
  });

  it("names no base when the default has nothing to compare against", async () => {
    vi.mocked(mockTransport.getBranchComparison).mockResolvedValue({
      base: "refs/heads/main",
      compare: "refs/heads/main",
      isUnborn: false,
      isComparisonAvailable: false,
    });
    await renderPickers();
    expect(screen.getByTestId("branch-base-picker")).toHaveTextContent("Pick a base");
    expect(storedOperands()).toBeNull();
  });
});
