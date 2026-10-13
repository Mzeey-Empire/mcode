// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitSearchCommitsParams, GitSearchCommitsResult } from "@mcode/contracts";

import { mockTransport } from "@/__tests__/mocks/transport";
import { installListboxLayout } from "@/__tests__/helpers/picker-layout";
import { useDiffStore } from "@/stores/diffStore";
import { CommitOperandPicker } from "../CommitOperandPicker";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

installListboxLayout();

// 412 commits since the fork, newest first. The four "delete" commits all sit past the first page of 100.
const DELETE_AT = new Set([150, 200, 300, 400]);
const COMMITS = Array.from({ length: 412 }, (_, index) => {
  const sha = index.toString(16).padStart(4, "0").padEnd(40, "f");
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: DELETE_AT.has(index) ? `delete stale cache ${index}` : `tune layout ${index}`,
    date: "2026-10-01T12:00:00.000Z",
  };
});

let failNextSearch = false;

function searchPage(params: GitSearchCommitsParams): GitSearchCommitsResult {
  if (failNextSearch) {
    failNextSearch = false;
    return { ok: false, error: { code: "git_failed", message: "git log failed" } };
  }
  const query = params.query ?? "";
  const matches = COMMITS.filter((commit) => commit.subject.includes(query) || commit.sha.startsWith(query));
  return {
    ok: true,
    commits: matches.slice(params.offset, params.offset + params.limit),
    matchCount: matches.length,
    totalCount: COMMITS.length,
  };
}

let workspaceCount = 0;
let workspaceId = "";

beforeEach(() => {
  workspaceCount += 1;
  workspaceId = `ws-${workspaceCount}`;
  failNextSearch = false;
  vi.mocked(mockTransport.searchCommits).mockReset().mockImplementation(async (params) => searchPage(params));
  useDiffStore.setState({ selectedCommitSha: null });
});

function renderPicker() {
  render(<CommitOperandPicker workspaceId={workspaceId} threadId="thread-1" diffScopeRevision={0} />);
}

describe("CommitOperandPicker", () => {
  it("picks the latest commit by default and names it on the trigger", async () => {
    renderPicker();
    await waitFor(() => expect(useDiffStore.getState().selectedCommitSha).toBe(COMMITS[0]!.sha));
    const trigger = screen.getByTestId("commit-picker-trigger");
    expect(trigger).toHaveTextContent(COMMITS[0]!.shortSha);
    expect(trigger).toHaveTextContent("tune layout 0");
  });

  it("finds matches beyond the first page on the server and counts them against the whole range", async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId("commit-picker-trigger"));
    expect(await screen.findByText("412 commits")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "delete" } });

    expect(await screen.findByText("4 matches in 412 commits")).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      [150, 200, 300, 400].map((index) => expect.stringContaining(`delete stale cache ${index}`)),
    );
    expect(vi.mocked(mockTransport.searchCommits)).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId, threadId: "thread-1", query: "delete", offset: 0 }),
    );
  });

  it("stores the picked commit and closes", async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId("commit-picker-trigger"));
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "delete" } });
    await screen.findByText("4 matches in 412 commits");

    fireEvent.click(screen.getByRole("option", { name: /delete stale cache 300/ }));

    expect(useDiffStore.getState().selectedCommitSha).toBe(COMMITS[300]!.sha);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(screen.getByTestId("commit-picker-trigger")).toHaveTextContent(`${COMMITS[300]!.shortSha}delete stale cache 300`);
  });

  it("shows an error row when the search fails, and lists commits after Retry", async () => {
    renderPicker();
    fireEvent.click(await screen.findByTestId("commit-picker-trigger"));
    await screen.findByText("412 commits");
    failNextSearch = true;
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "delete" } });

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn't load the list")).toBeInTheDocument();
    expect(within(alert).getByText("git log failed")).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("4 matches in 412 commits")).toBeInTheDocument();
  });
});
