// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommitParams, GitCommitResult, ReviewFileChange } from "@mcode/contracts";

import { mockTransport } from "@/__tests__/mocks/transport";
import { PUSH_POLL_INTERVAL_MS } from "@/hooks/useCommitSheet";
import { useConnectionStore } from "@/stores/connectionStore";
import { CommitSheet } from "../CommitSheet";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const HEAD = "a".repeat(40);

function change(path: string, overrides: Partial<ReviewFileChange> = {}): ReviewFileChange {
  return {
    path,
    previousPath: null,
    changeType: "modified",
    binary: false,
    additions: 1,
    deletions: 0,
    untracked: false,
    ...overrides,
  };
}

function gitState(branch: string | null) {
  return {
    isGitRepo: true as const,
    head: HEAD,
    branch,
    uncommitted: { staged: 0, unstaged: 3, untracked: 1 },
    commitsAhead: null,
  };
}

function arrange(files: ReviewFileChange[], branch: string | null = "feat/x") {
  vi.mocked(mockTransport.getReviewComparison).mockResolvedValue({
    status: "ready",
    comparison: { files, additions: 0, deletions: 0 },
  } as never);
  vi.mocked(mockTransport.getReviewState).mockResolvedValue(gitState(branch) as never);
}

function committed(push: "skipped" | "pending" = "skipped"): GitCommitResult {
  return {
    status: "committed",
    sha: HEAD,
    shortSha: "aaaaaaa",
    branch: "feat/x",
    push: { status: push },
  } as GitCommitResult;
}

function renderSheet(onClose = vi.fn()) {
  render(<CommitSheet workspaceId="ws-1" threadId="thread-1" scopeId="thread-1" activePath={null} onClose={onClose} />);
  return onClose;
}

function commitButton() {
  return screen.getByRole("button", { name: /^Commit (\d+ files?|[^a-z]*)$/ });
}

async function ready() {
  await screen.findByTestId("commit-file-list");
  await waitFor(() => expect(commitButton()).toBeEnabled());
}

/** A file row's checkbox is named by its row text, which starts with the file's name. */
function fileBox(name: string) {
  return screen.getByRole("checkbox", { name: new RegExp(`^${name.replace(/\./g, "\\.")}`) });
}

function sentRequests(): GitCommitParams[] {
  return vi.mocked(mockTransport.commitChanges).mock.calls.map(([params]) => params);
}

beforeEach(() => {
  vi.mocked(mockTransport.commitChanges).mockReset().mockResolvedValue(committed());
  vi.mocked(mockTransport.generateCommitMessage).mockReset().mockResolvedValue({
    status: "ok",
    subject: "feat: add things",
    body: "Because.",
    model: { provider: "claude", id: "haiku", name: "Haiku 5.5" },
  } as never);
  useConnectionStore.setState({ status: "connected" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CommitSheet selection", () => {
  it("checks tracked files and leaves untracked ones for the user", async () => {
    arrange([change("a.ts"), change("b.ts"), change("new.ts", { untracked: true, changeType: "added" })]);
    renderSheet();
    await ready();

    expect(fileBox("a.ts")).toBeChecked();
    expect(fileBox("new.ts")).not.toBeChecked();
    expect(commitButton()).toHaveTextContent("Commit 2 files");
    expect(screen.getByText("2 of 3 files")).toBeInTheDocument();
  });

  it("commits exactly the checked files with the head the list was read at", async () => {
    arrange([change("a.ts"), change("old.ts", { previousPath: "was.ts", changeType: "renamed" }), change("n.ts", { untracked: true })]);
    renderSheet();
    await ready();

    fireEvent.click(fileBox("n.ts"));
    fireEvent.click(fileBox("a.ts"));
    fireEvent.click(commitButton());

    await waitFor(() => expect(sentRequests()).toHaveLength(1));
    expect(sentRequests()[0]).toMatchObject({
      expectedHead: HEAD,
      files: [{ path: "old.ts", previousPath: "was.ts" }, { path: "n.ts", previousPath: null }],
      message: "feat: add things\n\nBecause.",
      push: false,
    });
  });

  it("disables Commit once nothing is checked", async () => {
    arrange([change("a.ts")]);
    renderSheet();
    await ready();

    fireEvent.click(fileBox("a.ts"));

    expect(commitButton()).toBeDisabled();
    expect(commitButton()).toHaveTextContent("Commit 0 files");
  });

  it("disables Commit while the message is empty", async () => {
    arrange([change("a.ts")]);
    renderSheet();
    await ready();

    fireEvent.change(screen.getByLabelText("Commit subject"), { target: { value: "  " } });
    fireEvent.change(screen.getByLabelText("Commit body"), { target: { value: "" } });

    expect(commitButton()).toBeDisabled();
  });

  it("groups past ten files, with a folder checkbox that shows a partial selection", async () => {
    const files = Array.from({ length: 12 }, (_, index) => change(`src/ui/f${index}.ts`));
    files.push(change("src/lib/x.ts"), change("src/lib/y.ts"), change("README.md"));
    arrange(files);
    renderSheet();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: "Expand src/ui" }));
    fireEvent.click(fileBox("f0.ts"));

    expect(screen.getByRole("checkbox", { name: "Select src/ui" })).toBePartiallyChecked();
    expect(screen.getByText("14 of 15 files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/ui" }));
    expect(screen.getByRole("checkbox", { name: "Select src/ui" })).toBeChecked();
  });
});

describe("CommitSheet outcomes", () => {
  it("closes after a plain commit", async () => {
    arrange([change("a.ts")]);
    const onClose = renderSheet();
    await ready();

    fireEvent.click(commitButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the selection and message after a hook failure, and sends a new request id on retry", async () => {
    arrange([change("a.ts"), change("b.ts")]);
    vi.mocked(mockTransport.commitChanges).mockResolvedValueOnce({
      status: "rejected",
      reason: { kind: "failed", summary: "pre-commit hook failed", detail: "lint error" },
    } as never);
    const onClose = renderSheet();
    await ready();

    fireEvent.click(fileBox("b.ts"));
    fireEvent.click(commitButton());

    await screen.findByText(/pre-commit hook failed/);
    expect(onClose).not.toHaveBeenCalled();
    expect(fileBox("a.ts")).toBeChecked();
    expect(fileBox("b.ts")).not.toBeChecked();
    expect(screen.getByLabelText("Commit subject")).toHaveValue("feat: add things");

    await waitFor(() => expect(commitButton()).toBeEnabled());
    fireEvent.click(commitButton());
    await waitFor(() => expect(sentRequests()).toHaveLength(2));
    expect(sentRequests()[1]?.requestId).not.toBe(sentRequests()[0]?.requestId);
  });

  it("resends the same request id when the connection returns after a drop", async () => {
    arrange([change("a.ts")]);
    vi.mocked(mockTransport.commitChanges).mockRejectedValueOnce(new Error("WebSocket disconnected"));
    const onClose = renderSheet();
    await ready();

    act(() => useConnectionStore.setState({ status: "reconnecting" }));
    fireEvent.click(commitButton());
    await waitFor(() => expect(sentRequests()).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();

    act(() => useConnectionStore.setState({ status: "connected" }));

    await waitFor(() => expect(sentRequests()).toHaveLength(2));
    expect(sentRequests()[1]?.requestId).toBe(sentRequests()[0]?.requestId);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("shows Pushing… and polls the same request until the push settles", async () => {
    arrange([change("a.ts")]);
    vi.mocked(mockTransport.commitChanges)
      .mockResolvedValueOnce(committed("pending"))
      .mockResolvedValueOnce(committed("pending"))
      .mockResolvedValueOnce({ ...committed(), push: { status: "pushed" } } as never);
    const onClose = renderSheet();
    await ready();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    fireEvent.click(screen.getByRole("button", { name: "More commit actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Commit and push" }));

    await screen.findByText("Pushing…");
    await act(() => vi.advanceTimersByTimeAsync(PUSH_POLL_INTERVAL_MS * 2));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(sentRequests()).toHaveLength(3);
    expect(new Set(sentRequests().map((params) => params.requestId)).size).toBe(1);
    expect(sentRequests()[0]?.push).toBe(true);
  });

  it("offers no retry when the outcome is unknown", async () => {
    arrange([change("a.ts")]);
    vi.mocked(mockTransport.commitChanges).mockResolvedValueOnce({
      status: "unknown",
      head: "b".repeat(40),
      detail: "git exited without a result",
    } as never);
    renderSheet();
    await ready();

    fireEvent.click(commitButton());

    await screen.findByText("Couldn't confirm the commit");
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(commitButton()).toBeDisabled();
  });

  it("keeps the sheet open and reports a failed push with the commit already made", async () => {
    arrange([change("a.ts")]);
    vi.mocked(mockTransport.commitChanges).mockResolvedValueOnce({
      ...committed(),
      push: { status: "failed", summary: "remote rejected", detail: "non-fast-forward" },
    } as never);
    const onClose = renderSheet();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: "More commit actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Commit and push" }));

    await screen.findByText(/but the push failed/);
    expect(onClose).not.toHaveBeenCalled();
    expect(commitButton()).toBeDisabled();
  });
});

describe("CommitSheet branchless checkout", () => {
  it("disables Commit and push with the reason", async () => {
    arrange([change("a.ts")], null);
    renderSheet();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: "More commit actions" }));

    const item = await screen.findByRole("menuitem", { name: "Commit and push" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(sentRequests()).toHaveLength(0);
  });
});
