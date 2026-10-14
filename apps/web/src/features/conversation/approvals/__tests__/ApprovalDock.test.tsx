import { createMockApproval, createMockThread } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useApprovalStore } from "@/stores/approvalStore";
import type { McodeTransport } from "@/transport/types";
import type { ApprovalRequest, ApprovalSubject } from "@mcode/contracts";
import { disposeHighlighter } from "@pierre/diffs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_ARM_DELAY_MS, ApprovalAnnouncer, ApprovalDock, useDockApprovals } from "../ApprovalDock";

const { respondToApproval } = vi.hoisted(() => ({
  respondToApproval: vi.fn<McodeTransport["respondToApproval"]>(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ respondToApproval }),
}));

interface DockHarnessProps {
  readonly threadId?: string;
  readonly onStop?: () => void;
}

function DockHarness({ threadId = "thread-1", onStop }: DockHarnessProps) {
  const composerRef = useRef<HTMLDivElement>(null);
  const requests = useDockApprovals(threadId);
  return (
    <>
      <input aria-label="Terminal" />
      <ApprovalAnnouncer requests={requests} />
      {requests.length > 0 && (
        <ApprovalDock
          requests={requests}
          composerContainerRef={composerRef}
          isAgentRunning={onStop !== undefined}
          isStopPending={false}
          onStop={onStop ?? (() => {})}
          onFocusComposer={() => composerRef.current?.querySelector("textarea")?.focus()}
        />
      )}
      <div ref={composerRef} hidden={requests.length > 0}><textarea aria-label="Composer" /></div>
    </>
  );
}

function addApproval(overrides: Partial<ApprovalRequest> = {}) {
  act(() => useApprovalStore.getState().add(createMockApproval(overrides)));
}

async function elapseGuard() {
  await act(() => vi.advanceTimersByTimeAsync(APPROVAL_ARM_DELAY_MS));
}

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  respondToApproval.mockReset().mockResolvedValue({ status: "resolved" });
  useApprovalStore.setState({ approvals: [], submissions: {} });
  useWorkspaceStore.setState({ threads: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalDock keys", () => {
  it("answers with the numbered choice once the guard has elapsed", async () => {
    const user = setupUser();
    addApproval();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("1");

    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "allow" });
    expect(screen.queryByTestId("approval-dock")).not.toBeInTheDocument();
  });

  it("ignores a digit pressed before the guard elapses", async () => {
    const user = setupUser();
    addApproval();
    render(<DockHarness />);

    await user.keyboard("1");

    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("ignores a click until 600ms after the dock appears", async () => {
    vi.useFakeTimers();
    addApproval();
    render(<DockHarness />);
    const allow = screen.getByRole("button", { name: /Allow once/ });

    await act(() => vi.advanceTimersByTimeAsync(599));
    fireEvent.click(allow);
    expect(respondToApproval).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    fireEvent.click(allow);
    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "allow" });
  });

  it("re-arms the guard when the user was typing", async () => {
    const user = setupUser();
    addApproval();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("x");
    await user.keyboard("2");
    expect(respondToApproval).not.toHaveBeenCalled();

    await elapseGuard();
    await user.keyboard("2");
    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "deny" });
  });

  it("moves between rows with the arrows and answers with Enter", async () => {
    const user = setupUser();
    addApproval();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("{ArrowDown}{Enter}");

    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "deny" });
  });

  it("lets Enter on the stop button stop the agent instead of answering", async () => {
    const onStop = vi.fn();
    const user = setupUser();
    addApproval();
    render(<DockHarness onStop={onStop} />);
    await elapseGuard();

    act(() => screen.getByRole("button", { name: "Stop agent" }).focus());
    await user.keyboard("{Enter}");

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("sends each deny row's own choice id", async () => {
    const user = setupUser();
    addApproval({
      choices: [
        { id: "allow", intent: "allow_once", label: "Allow once" },
        { id: "deny", intent: "deny", label: "Deny" },
        { id: "abort", intent: "deny", label: "Deny and stop" },
      ],
    });
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("3");

    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "abort" });
  });
});

describe("ApprovalDock queue", () => {
  it("pages oldest first and advances to the next request after a decision", async () => {
    const user = setupUser();
    addApproval({ requestId: "late", requestedAt: "2026-10-10T10:00:03Z", subject: { kind: "command", command: "echo late" } });
    addApproval({ requestId: "early", requestedAt: "2026-10-10T10:00:01Z", subject: { kind: "command", command: "echo early" } });
    addApproval({ requestId: "middle", requestedAt: "2026-10-10T10:00:02Z", subject: { kind: "command", command: "echo middle" } });
    render(<DockHarness />);
    await elapseGuard();

    expect(screen.getByText("echo early")).toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    await user.keyboard("]");
    expect(screen.getByText("echo middle")).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    await user.keyboard("1");
    expect(respondToApproval).toHaveBeenCalledWith("middle", { choiceId: "allow" });
    expect(await screen.findByText("echo late")).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();

    await user.keyboard("1");
    expect(respondToApproval).toHaveBeenCalledTimes(1);
  });

  it("pages between question requests with the brackets once a body is on its last question", async () => {
    const user = setupUser();
    const subject = (question: string): ApprovalSubject => ({
      kind: "question",
      questions: [{ header: "Scope", question, options: [{ label: "Narrow" }, { label: "Wide" }], multiple: false, custom: false }],
    });
    addApproval({ requestId: "first", requestedAt: "2026-10-10T10:00:01Z", subject: subject("First question?") });
    addApproval({ requestId: "second", requestedAt: "2026-10-10T10:00:02Z", subject: subject("Second question?") });
    render(<DockHarness />);
    await elapseGuard();
    act(() => screen.getAllByRole("button", { name: /Narrow/ })[0]!.focus());

    await user.keyboard("]");

    expect(screen.getByText("Second question?")).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("dims the other rows while an answer is in flight", async () => {
    respondToApproval.mockReturnValue(new Promise(() => {}));
    const user = setupUser();
    addApproval();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("1");

    expect(screen.getByText("Allowing once…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deny/ })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("2");
    expect(respondToApproval).toHaveBeenCalledTimes(1);
  });

  it("offers a retry that resends the same choice when the answer fails", async () => {
    respondToApproval.mockResolvedValueOnce({ status: "failed", message: "offline" });
    const user = setupUser();
    addApproval();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("2");
    expect(await screen.findByRole("alert")).toHaveTextContent("Your answer didn't reach Codex.");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(respondToApproval.mock.calls).toEqual([["req-1", { choiceId: "deny" }], ["req-1", { choiceId: "deny" }]]);
    expect(screen.queryByTestId("approval-dock")).not.toBeInTheDocument();
  });

  it("retries the failed choice, not the focused row, when Enter is pressed on Try again", async () => {
    respondToApproval.mockResolvedValueOnce({ status: "failed", message: "offline" });
    const user = setupUser();
    addApproval();
    render(<DockHarness />);
    await elapseGuard();
    await user.keyboard("2");
    await screen.findByRole("alert");

    act(() => screen.getByRole("button", { name: "Try again" }).focus());
    await user.keyboard("{Enter}");

    expect(respondToApproval.mock.calls).toEqual([["req-1", { choiceId: "deny" }], ["req-1", { choiceId: "deny" }]]);
  });

  it("stays on the shown request when an earlier one is answered elsewhere", async () => {
    const user = setupUser();
    for (const [requestId, second] of [["a", 1], ["b", 2], ["c", 3], ["d", 4]] as const) {
      addApproval({ requestId, requestedAt: `2026-10-10T10:00:0${second}Z`, subject: { kind: "command", command: `echo ${requestId}` } });
    }
    render(<DockHarness />);
    await elapseGuard();
    await user.keyboard("]");
    await user.keyboard("1");
    expect(await screen.findByText("echo c")).toBeInTheDocument();

    act(() => useApprovalStore.getState().resolve("a"));

    expect(screen.getByText("echo c")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("forgets a failed answer when a reconnect drops the request", async () => {
    respondToApproval.mockResolvedValueOnce({ status: "failed", message: "offline" });
    const user = setupUser();
    addApproval();
    render(<DockHarness />);
    await elapseGuard();
    await user.keyboard("2");
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    act(() => useApprovalStore.getState().hydrate([]));
    addApproval();

    expect(screen.getByTestId("approval-dock")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ApprovalDock focus and announcements", () => {
  it("does not take focus from an input outside the composer", async () => {
    const user = setupUser();
    render(<DockHarness />);
    const terminal = screen.getByRole("textbox", { name: "Terminal" });
    await user.click(terminal);

    addApproval();
    await elapseGuard();
    await user.keyboard("1");

    expect(terminal).toHaveFocus();
    expect(terminal).toHaveValue("1");
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("takes focus from the composer and hands it back after the decision", async () => {
    const user = setupUser();
    render(<DockHarness />);
    await user.click(screen.getByRole("textbox", { name: "Composer" }));

    addApproval();
    expect(screen.getByRole("button", { name: /Allow once/ })).toHaveFocus();
    await elapseGuard();
    await user.keyboard("1");

    expect(screen.getByRole("textbox", { name: "Composer" })).toHaveFocus();
  });

  it("announces the newest request and how many are waiting", () => {
    render(<DockHarness />);
    addApproval({ requestId: "a", requestedAt: "2026-10-10T10:00:01Z" });
    addApproval({ requestId: "b", requestedAt: "2026-10-10T10:00:02Z", subject: { kind: "fetch", url: "https://example.com" } });

    expect(document.querySelector("[aria-live='assertive']")).toHaveTextContent("Codex wants to fetch a page, 2 waiting");
  });
});

describe("ApprovalDock subjects", () => {
  it("shows a cross-thread send on the asking thread only, with the target's title", () => {
    act(() => useWorkspaceStore.setState({ threads: [createMockThread({ id: "thread-b", title: "Release notes" })] }));
    addApproval({
      threadId: "thread-a",
      subject: { kind: "thread_operation", operation: "thread_send", targetThreadId: "thread-b", message: "Ship it" },
    });
    const { unmount } = render(<DockHarness threadId="thread-a" />);

    expect(screen.getByRole("heading", { name: "Codex wants to message another thread" })).toBeInTheDocument();
    expect(screen.getByText(/Release notes/)).toBeInTheDocument();
    unmount();

    render(<DockHarness threadId="thread-b" />);
    expect(screen.queryByTestId("approval-dock")).not.toBeInTheDocument();
  });

  it("hides the note row when the provider cannot take a note", () => {
    addApproval({ noteDelivery: "none", noteChoiceId: undefined });
    render(<DockHarness />);

    expect(screen.queryByText("Tell Codex what to do instead…")).not.toBeInTheDocument();
  });

  it("shows the note row when the provider can take a note", () => {
    addApproval();
    render(<DockHarness />);

    expect(screen.getByText("Tell Codex what to do instead…")).toBeInTheDocument();
  });

  it("names a subagent in its chip rather than the title", () => {
    addApproval({ origin: { kind: "subagent", label: "Explorer" } });
    render(<DockHarness />);

    expect(screen.getByRole("heading", { name: "Wants to run a command" })).toBeInTheDocument();
    expect(screen.getByText("Explorer")).toBeInTheDocument();
  });

  it("marks a subagent chip with the asking provider's icon", () => {
    addApproval({ providerId: "claude", origin: { kind: "subagent", label: "Print date", parentToolCallId: "toolu_agent" } });
    render(<DockHarness />);

    const chip = screen.getByText("Print date").parentElement;
    expect(chip?.querySelector('[data-provider-icon="claude"]')).not.toBeNull();
  });

  it("shows no provider chip when the main agent asks", () => {
    addApproval({ providerId: "claude" });
    const { container } = render(<DockHarness />);

    expect(container.querySelector("[data-provider-icon]")).toBeNull();
  });
});

const SHORT_PATCH = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = () => 1;\n";
const LONG_PATCH = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep();\n-old();\n+next();\n tail();\n";
const TWO_HUNK_PATCH = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-one();\n+uno();\n@@ -9 +9 @@\n+nine();\n";

/** Pierre draws into a shadow root, so screen queries cannot see the diff text. */
function renderedDiffText(container: Element): string {
  return [...container.querySelectorAll("*")].map((node) => node.shadowRoot?.textContent ?? "").join("");
}

function addFileEdit(files: Extract<ApprovalSubject, { kind: "file_edit" }>["files"]) {
  addApproval({ subject: { kind: "file_edit", files } });
}

describe("ApprovalDock file edits", () => {
  it("shows the diff without Open diff when it fits in three lines", () => {
    addFileEdit([{ path: "src/a.ts", change: "edited", additions: 1, deletions: 1, patch: SHORT_PATCH }]);
    render(<DockHarness />);

    expect(screen.getByTestId("approval-patch-preview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open diff" })).not.toBeInTheDocument();
  });

  it("previews only the first three rows and opens the rest", async () => {
    const user = setupUser();
    addFileEdit([{ path: "src/a.ts", change: "edited", additions: 1, deletions: 1, patch: LONG_PATCH }]);
    render(<DockHarness />);

    await vi.waitFor(() => expect(renderedDiffText(screen.getByTestId("approval-patch-preview"))).toContain("next();"));
    expect(renderedDiffText(screen.getByTestId("approval-patch-preview"))).not.toContain("tail();");
    await user.click(screen.getByRole("button", { name: "Open diff" }));

    const dialog = await screen.findByRole("dialog", { name: "Proposed changes" });
    await vi.waitFor(() => expect(renderedDiffText(dialog)).toContain("tail();"));
  });

  it("draws the preview under StrictMode while the highlighter is still loading", async () => {
    await disposeHighlighter();
    addFileEdit([{ path: "src/a.ts", change: "edited", additions: 1, deletions: 1, patch: LONG_PATCH }]);
    render(<StrictMode><DockHarness /></StrictMode>);

    await vi.waitFor(() => expect(renderedDiffText(screen.getByTestId("approval-patch-preview"))).toContain("next();"));
  });

  it("offers Open diff when a later hunk would not fit", () => {
    addFileEdit([{ path: "src/a.ts", change: "edited", additions: 2, deletions: 1, patch: TWO_HUNK_PATCH }]);
    render(<DockHarness />);

    expect(screen.getByRole("button", { name: "Open diff" })).toBeInTheDocument();
  });

  it("keeps later files reachable when the first file has no patch", async () => {
    const user = setupUser();
    addFileEdit([
      { path: "src/big.ts", change: "edited", additions: 0, deletions: 0, patchTruncated: true },
      { path: "src/a.ts", change: "edited", additions: 1, deletions: 1, patch: SHORT_PATCH },
      { path: "src/c.ts", change: "edited", additions: 1, deletions: 1, patch: SHORT_PATCH },
    ]);
    render(<DockHarness />);

    expect(screen.getByText("+2 files")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-patch-preview")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open diff" }));

    const dialog = await screen.findByRole("dialog", { name: "Proposed changes" });
    await vi.waitFor(() => expect(renderedDiffText(dialog)).toContain("const a = () => 1;"));
  });

  it("opens every file's full patch when the first diff runs past three lines", async () => {
    const user = setupUser();
    addFileEdit([
      { path: "src/a.ts", change: "edited", additions: 1, deletions: 1, patch: LONG_PATCH },
      { path: "src/b.ts", change: "added", additions: 0, deletions: 0, patchTruncated: true },
    ]);
    render(<DockHarness />);

    expect(screen.getByText("+1 file")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open diff" }));

    const dialog = await screen.findByRole("dialog", { name: "Proposed changes" });
    expect(dialog).toHaveTextContent("src/a.ts");
    expect(dialog).toHaveTextContent("src/b.ts");
    expect(dialog).toHaveTextContent("No diff available");
  });

  it("keeps digits typed in the full diff from answering the request", async () => {
    const user = setupUser();
    addFileEdit([{ path: "src/a.ts", change: "edited", additions: 1, deletions: 1, patch: LONG_PATCH }]);
    render(<DockHarness />);
    await elapseGuard();

    await user.click(screen.getByRole("button", { name: "Open diff" }));
    await screen.findByRole("dialog", { name: "Proposed changes" });
    await user.keyboard("1");

    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("shows only the path row when the provider sent no patch", () => {
    addFileEdit([{ path: "src/devin.ts", change: "edited", additions: 0, deletions: 0 }]);
    render(<DockHarness />);

    expect(screen.getByText("devin.ts")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-patch-preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open diff" })).not.toBeInTheDocument();
  });
});
