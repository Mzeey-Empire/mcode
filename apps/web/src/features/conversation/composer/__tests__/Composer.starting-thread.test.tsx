import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { mockTransport, createMockThread, createMockWorkspace } from "@/__tests__/mocks/transport";

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
vi.mock("@/components/chat/TerminalStatusIndicator", () => ({ TerminalStatusIndicator: () => <div /> }));
vi.mock("@/components/chat/ComposerQueueList", () => ({ ComposerQueueList: () => <div /> }));
vi.mock("@/components/chat/ContextTracker", () => ({ ContextTracker: () => <div /> }));
vi.mock("@/components/chat/RetryBanner", () => ({ RetryBanner: () => <div /> }));
vi.mock("@/components/chat/SlashCommandPopup", () => ({ SlashCommandPopup: () => <div /> }));

function seedStartingThread() {
  const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
  const thread = createMockThread({ id: "thread-1", workspace_id: workspace.id, mode: "worktree", provider: "codex" });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    threads: [thread],
    activeThreadId: thread.id,
    newThreadMode: "direct",
    newThreadBranch: "main",
    selectedWorktree: null,
  });
}

function renderStarting(onCancel: (() => void) | undefined) {
  return render(<Composer threadId="thread-1" workspaceId="ws-1" startingThread={{ onCancel }} />);
}

describe("Composer while the thread is starting", () => {
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
    seedStartingThread();
  });

  it("makes the editor inert and swaps Send for Stop", () => {
    renderStarting(vi.fn());

    const editor = screen.getByLabelText("Message Mcode");
    expect(editor).toBeDisabled();
    expect(editor).toHaveAttribute("placeholder", "Do anything");
    expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Cancel startup")).toBeEnabled();
    expect(screen.getByTestId("composer-starting-spinner")).toBeInTheDocument();
  });

  it("cancels the startup from Stop without sending a message", async () => {
    const onCancel = vi.fn();
    renderStarting(onCancel);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Message Mcode"), "Build this{Enter}");
    await user.click(screen.getByLabelText("Cancel startup"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(mockTransport.createAndSendMessage).not.toHaveBeenCalled();
  });

  it("disables Stop once cancellation is requested", () => {
    renderStarting(undefined);

    expect(screen.getByLabelText("Cancel startup")).toBeDisabled();
  });

  it("cancels the startup on Esc", () => {
    const onCancel = vi.fn();
    renderStarting(onCancel);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("leaves Esc to an open picker", () => {
    const onCancel = vi.fn();
    renderStarting(onCancel);
    render(<div role="dialog" aria-label="Choose model and provider" />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("ignores Esc while focus is outside the thread view", () => {
    const onCancel = vi.fn();
    renderStarting(onCancel);
    render(<input aria-label="Sidebar search" />);
    const outside = screen.getByLabelText("Sidebar search");
    outside.focus();

    fireEvent.keyDown(outside, { key: "Escape" });

    expect(onCancel).not.toHaveBeenCalled();
  });
});
