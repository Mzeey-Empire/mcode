import { createMockApproval, createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Composer } from "../Composer";
import { extractComposerMessage } from "@/components/chat/lexical";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useApprovalStore } from "@/stores/approvalStore";
import { useQueueStore } from "@/stores/queueStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

vi.mock("@/components/chat/lexical", () => ({
  ComposerEditor: ({
    onChange,
    editorRef,
    ariaLabel,
    disabled,
    placeholder,
  }: {
    onChange: (text: string, mentions: []) => void;
    editorRef: React.MutableRefObject<{ update: (fn: () => void) => void; focus: () => void } | null>;
    ariaLabel?: string;
    disabled?: boolean;
    placeholder?: string;
  }) => {
    React.useEffect(() => {
      editorRef.current = { update: vi.fn(), focus: vi.fn() };
    }, [editorRef]);
    return (
      <textarea
        aria-label={ariaLabel}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value, [])}
      />
    );
  },
  $createTypedMentionNode: vi.fn(),
  extractComposerMessage: vi.fn(() => ({ text: "", mentions: [] })),
  insertMentionNode: vi.fn(),
  insertSlashCommandNode: vi.fn(),
}));

vi.mock("@/components/chat/useFileAutocomplete", () => ({
  clearFileListCache: vi.fn(),
  useFileAutocomplete: () => ({
    suggestions: [],
    query: "",
    isOpen: false,
    triggerStart: 0,
    selectSuggestion: vi.fn(),
    handleInputChange: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("@/components/chat/useSlashCommand", () => ({
  useSlashCommand: () => ({
    state: null,
    selectedIndex: 0,
    anchorRect: null,
    isOpen: false,
    onInputChange: vi.fn(),
    onDismiss: vi.fn(),
    onSelect: vi.fn(),
    onKeyDown: vi.fn(),
    onRetry: vi.fn(),
  }),
}));

vi.mock("@/components/chat/ModelSelector", () => ({
  ModelSelector: () => <div />,
}));

vi.mock("@/components/chat/FileTagPopup", () => ({
  FileTagPopup: () => <div />,
  useFileTagPopup: () => ({ listRef: { current: null }, selectedIndex: 0, onKeyDown: vi.fn() }),
}));

vi.mock("@/components/chat/SpellcheckContextMenu", () => ({ SpellcheckContextMenu: () => <div /> }));
vi.mock("@/components/chat/SlashCommandTray", () => ({ SlashCommandTray: () => <div /> }));

function seedIdleThread() {
  const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
  const thread = createMockThread({ id: "thread-1", workspace_id: workspace.id, provider: "codex" });
  useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id, threads: [thread], activeThreadId: thread.id });
}

describe("Composer while the approval dock shows", () => {
  beforeAll(() => {
    if (typeof window.ResizeObserver === "undefined") {
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadStoreForTests({ runningThreadIds: new Set() });
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    useApprovalStore.setState({ approvals: [], submissions: {} });
    useQueueStore.setState({ queues: {}, inFlightQueuedMessages: {}, editingThreadId: null });
    seedIdleThread();
  });

  it("closes an open add menu instead of leaving it over the dock, and keeps it closed when the composer returns", async () => {
    render(<Composer threadId="thread-1" workspaceId="ws-1" />);
    await userEvent.setup().click(screen.getByLabelText("Add to composer"));
    expect(screen.getByTestId("composer-add-menu")).toBeInTheDocument();

    act(() => useApprovalStore.getState().add(createMockApproval({ requestId: "approval-1", threadId: "thread-1" })));
    expect(screen.getByTestId("approval-dock")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-add-menu")).not.toBeInTheDocument();

    act(() => useApprovalStore.getState().resolve("approval-1"));
    expect(screen.queryByTestId("approval-dock")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Add to composer")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("composer-add-menu")).not.toBeInTheDocument();
  });

  it("saves an edited queued message back to its slot while the agent runs", async () => {
    const user = userEvent.setup();
    resetThreadStoreForTests({ runningThreadIds: new Set(["thread-1"]) });
    for (const content of ["first", "second"]) {
      useQueueStore.getState().enqueue("thread-1", { content, displayContent: content, attachments: [], model: "gpt-5", permissionMode: "full" });
    }
    render(<Composer threadId="thread-1" workspaceId="ws-1" />);

    await user.click(screen.getByLabelText("Edit queued message 1"));
    expect(screen.getByText("Editing a queued message")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Editing");
    expect(within(rows[1]!).getByLabelText("Edit queued message 2")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Message Mcode" }), "first edited");
    vi.mocked(extractComposerMessage).mockReturnValue({ text: "first edited", mentions: [] });
    onTestFinished(() => void vi.mocked(extractComposerMessage).mockReturnValue({ text: "", mentions: [] }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(useQueueStore.getState().queues["thread-1"]?.map((message) => message.content)).toEqual(["first edited", "second"]));
  });

  it("disables editing a queued message while the dock hides the composer input", () => {
    useQueueStore.getState().enqueue("thread-1", {
      content: "queued follow-up",
      displayContent: "queued follow-up",
      attachments: [],
      model: "gpt-5",
      permissionMode: "full",
    });
    render(<Composer threadId="thread-1" workspaceId="ws-1" />);
    expect(screen.getByLabelText("Edit queued message 1")).toBeEnabled();

    act(() => useApprovalStore.getState().add(createMockApproval({ requestId: "approval-1", threadId: "thread-1" })));
    expect(screen.getByLabelText("Edit queued message 1")).toBeDisabled();
    expect(screen.getByLabelText("Remove queued message 1")).toBeEnabled();

    act(() => useApprovalStore.getState().resolve("approval-1"));
    expect(screen.getByLabelText("Edit queued message 1")).toBeEnabled();
  });
});
