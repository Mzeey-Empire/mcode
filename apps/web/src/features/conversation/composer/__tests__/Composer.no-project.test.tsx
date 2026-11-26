import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { NO_PROJECT_DRAFT_WORKSPACE_ID, useThreadDraftStore } from "@/stores/threadDraftStore";
import { useToastStore } from "@/stores/toastStore";
import { mockTransport } from "@/__tests__/mocks/transport";
import { editStartupMessage } from "@/features/thread-startup";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { pushEmitter } from "@/transport/ws-transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

let lastComposerText = "";

vi.mock("@/components/chat/lexical", () => ({
  ComposerEditor: ({
    onChange,
    onSubmit,
    editorRef,
    ariaLabel,
  }: {
    onChange: (text: string, mentions: []) => void;
    onSubmit: () => void;
    editorRef: React.MutableRefObject<{ update: (fn: () => void) => void; focus: () => void } | null>;
    ariaLabel?: string;
  }) => {
    React.useEffect(() => {
      editorRef.current = { update: vi.fn(), focus: vi.fn() };
    }, [editorRef]);
    return (
      <textarea
        aria-label={ariaLabel}
        onChange={(event) => {
          lastComposerText = event.target.value;
          onChange(event.target.value, []);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          onSubmit();
        }}
      />
    );
  },
  $createTypedMentionNode: vi.fn(),
  extractComposerMessage: vi.fn(() => ({ text: lastComposerText, mentions: [] })),
  insertMentionNode: vi.fn(),
  insertSlashCommandNode: vi.fn(),
}));

vi.mock("@/features/conversation/composer/draft/composer-editor-content", () => ({
  writeComposerContent: vi.fn((_editor: unknown, text: string) => {
    lastComposerText = text;
  }),
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

vi.mock("@/components/chat/ModelSelector", () => ({ ModelSelector: () => <div /> }));
vi.mock("@/components/chat/AttachmentPreview", () => ({ AttachmentPreview: () => <div /> }));
vi.mock("@/components/chat/FileTagPopup", () => ({
  FileTagPopup: () => <div />,
  useFileTagPopup: () => ({ listRef: { current: null }, selectedIndex: 0, onKeyDown: vi.fn() }),
}));
vi.mock("@/components/chat/SpellcheckContextMenu", () => ({ SpellcheckContextMenu: () => <div /> }));
vi.mock("@/components/chat/ComposerQueueList", () => ({ ComposerQueueList: () => <div /> }));
vi.mock("@/components/chat/SlashCommandTray", () => ({ SlashCommandTray: () => <div /> }));

const PROJECT = createMockWorkspace({ id: "ws-project", name: "fixture-repo", is_git_repo: true });

function createdWorkspaceIds(): string[] {
  return vi.mocked(mockTransport.createNoProjectWorkspace).mock.calls.map(([id]) => id);
}

function NewThreadComposer() {
  const draftId = useWorkspaceStore((state) => state.activeDraftId);
  return <Composer isNewThread noProject draftId={draftId} />;
}

async function typeAndSend() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message Mcode"), "Build this");
  await user.click(screen.getByLabelText("Send message"));
}

describe("Composer on the No project target", () => {
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
    lastComposerText = "";
    resetThreadStoreForTests({ runningThreadIds: new Set() });
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    useThreadDraftStore.setState({ drafts: {} });
    useToastStore.setState({ toasts: [] });
    useWorkspaceStore.setState({
      workspaces: [PROJECT],
      workspacesLoaded: true,
      activeWorkspaceId: PROJECT.id,
      threads: [],
      activeThreadId: null,
      activeDraftId: null,
      newThreadTarget: { kind: "project" },
    });
    useWorkspaceStore.getState().beginNoProjectThread();
    // The last project's picker is remembered, and the No project canvas has no rail to clear it.
    useWorkspaceStore.setState({
      newThreadMode: "worktree",
      newThreadBranch: "feature/base",
      newThreadBranchSource: "pr",
      newThreadPullRequestNumber: 42,
      selectedWorktree: { name: "existing", path: "/repo/.worktrees/existing", branch: "feature/base" },
    });
    vi.mocked(mockTransport.createAndSendMessage).mockImplementation(async (params) => ({
      ...createMockThread({ id: "thread-created", workspace_id: params.workspaceId }),
      runtimeSnapshot: { threadId: "thread-created", turnExecutionId: "exec-test", phase: "running" },
    }));
  });

  it("creates the hidden workspace, then sends there in Direct mode with no branch", async () => {
    render(<NewThreadComposer />);

    await typeAndSend();

    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalledOnce());
    expect(mockTransport.createNoProjectWorkspace).toHaveBeenCalledOnce();
    const [hiddenId] = createdWorkspaceIds() as [string];
    expect(vi.mocked(mockTransport.createNoProjectWorkspace).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(mockTransport.createAndSendMessage).mock.invocationCallOrder[0]!);
    const sent = vi.mocked(mockTransport.createAndSendMessage).mock.calls[0]![0];
    expect(sent).toMatchObject({ workspaceId: hiddenId, mode: "direct", content: "Build this" });
    expect(sent.branch).toBeUndefined();
    expect(sent.pullRequestNumber).toBeUndefined();
    expect(sent.existingWorktreePath).toBeUndefined();
    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).toEqual([PROJECT.id, hiddenId]);
  });

  it("never lets the local draft key reach the server", async () => {
    render(<NewThreadComposer />);

    await typeAndSend();

    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalledOnce());
    expect(vi.mocked(mockTransport.createNoProjectWorkspace).mock.calls.flat()).not.toContain(NO_PROJECT_DRAFT_WORKSPACE_ID);
    expect(vi.mocked(mockTransport.createAndSendMessage).mock.calls[0]![0].workspaceId).not.toBe(NO_PROJECT_DRAFT_WORKSPACE_ID);
  });

  it("keeps the draft and text when the hidden workspace cannot be created, and a retry makes a new workspace", async () => {
    let failCreation!: (error: Error) => void;
    vi.mocked(mockTransport.createNoProjectWorkspace).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failCreation = reject;
    }));
    render(<NewThreadComposer />);

    await typeAndSend();
    await waitFor(() => expect(mockTransport.createNoProjectWorkspace).toHaveBeenCalledOnce());
    const [savedDraft] = Object.values(useThreadDraftStore.getState().drafts);
    await act(async () => failCreation(new Error("disk full")));

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(mockTransport.createAndSendMessage).not.toHaveBeenCalled();
    expect(Object.values(useThreadDraftStore.getState().drafts)).toEqual([savedDraft]);
    expect(savedDraft).toMatchObject({ workspaceId: NO_PROJECT_DRAFT_WORKSPACE_ID, draft: { input: "Build this" } });

    await userEvent.setup().click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalledOnce());
    const [failedId, retryId] = createdWorkspaceIds();
    expect(createdWorkspaceIds()).toHaveLength(2);
    expect(retryId).not.toBe(failedId);
    expect(vi.mocked(mockTransport.createAndSendMessage).mock.calls[0]![0]).toMatchObject({ workspaceId: retryId, content: "Build this" });
  });

  it("makes a different hidden workspace for a second send while the first thread is still being created", async () => {
    vi.mocked(mockTransport.createAndSendMessage).mockImplementationOnce(() => new Promise(() => {}));
    render(<NewThreadComposer />);

    await typeAndSend();
    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalledOnce());
    act(() => useWorkspaceStore.getState().beginNoProjectThread());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Message Mcode"), "Second");
    await user.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalledTimes(2));
    const [firstId, secondId] = createdWorkspaceIds();
    expect(secondId).not.toBe(firstId);
    expect(vi.mocked(mockTransport.createAndSendMessage).mock.calls.map(([params]) => params.workspaceId)).toEqual([firstId, secondId]);
  });

  it("sends to the new hidden workspace without moving the user, who opened a project thread while it was being made", async () => {
    let finishCreation!: () => void;
    vi.mocked(mockTransport.createNoProjectWorkspace).mockImplementationOnce((id) => new Promise((resolve) => {
      finishCreation = () => resolve(createMockWorkspace({ id, name: "No project", kind: "no_project", is_git_repo: false }));
    }));
    render(<NewThreadComposer />);

    await typeAndSend();
    await waitFor(() => expect(mockTransport.createNoProjectWorkspace).toHaveBeenCalledOnce());
    act(() => useWorkspaceStore.setState({ activeWorkspaceId: PROJECT.id, activeThreadId: "thread-open" }));
    await act(async () => finishCreation());

    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalledOnce());
    const [hiddenId] = createdWorkspaceIds() as [string];
    const sent = vi.mocked(mockTransport.createAndSendMessage).mock.calls[0]![0];
    expect(sent).toMatchObject({ workspaceId: hiddenId, mode: "direct" });
    expect(sent.branch).toBeUndefined();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(PROJECT.id);
  });

  async function failFirstSend() {
    vi.mocked(mockTransport.createAndSendMessage).mockRejectedValueOnce(new Error("provider offline"));
    render(<NewThreadComposer />);
    await typeAndSend();
    await waitFor(() => expect(useWorkspaceStore.getState().threads[0]?.clientError).toBeTruthy());
    const [hiddenId] = createdWorkspaceIds() as [string];
    return { hiddenId, placeholder: useWorkspaceStore.getState().threads[0]! };
  }

  function noProjectDrafts() {
    return Object.values(useThreadDraftStore.getState().drafts).filter((draft) => draft.workspaceId === NO_PROJECT_DRAFT_WORKSPACE_ID);
  }

  it("keeps a failed first send as a No project draft when the server expires its workspace", async () => {
    const { hiddenId, placeholder } = await failFirstSend();
    act(() => useWorkspaceStore.setState({ activeThreadId: placeholder.id }));
    startPushListeners();
    try {
      act(() => pushEmitter.emit("workspace.deleted", { workspaceId: hiddenId }));
    } finally {
      stopPushListeners();
    }

    const [kept] = noProjectDrafts();
    expect(kept?.draft.input).toBe("Build this");
    const state = useWorkspaceStore.getState();
    expect(state.threads.map((thread) => thread.id)).not.toContain(placeholder.id);
    expect(state.workspaces.map((workspace) => workspace.id)).not.toContain(hiddenId);
    expect(state.activeDraftId).toBe(kept!.id);
  });

  it("does not turn a conversation deleted in another window into a draft when its workspace expires", async () => {
    const hidden = createMockWorkspace({ id: "ws-hidden", name: "No project", kind: "no_project", is_git_repo: false });
    const stale = createMockThread({ id: "thread-deleted-elsewhere", workspace_id: hidden.id, title: "Old conversation" });
    useWorkspaceStore.setState({ workspaces: [PROJECT, hidden], threads: [stale], activeThreadId: stale.id });
    startPushListeners();
    try {
      act(() => pushEmitter.emit("workspace.deleted", { workspaceId: hidden.id }));
    } finally {
      stopPushListeners();
    }

    expect(noProjectDrafts()).toEqual([]);
    expect(useWorkspaceStore.getState().activeDraftId).toBeNull();
  });

  it("keeps a failed first send when a reload is the first sign its workspace expired", async () => {
    const { placeholder } = await failFirstSend();
    vi.mocked(mockTransport.listWorkspaces).mockResolvedValueOnce([PROJECT]);

    await act(() => useWorkspaceStore.getState().loadWorkspaces());

    expect(noProjectDrafts().map((draft) => draft.draft.input)).toEqual(["Build this"]);
    const state = useWorkspaceStore.getState();
    expect(state.threads.map((thread) => thread.id)).not.toContain(placeholder.id);
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual([PROJECT.id]);
  });

  it("does not treat a No project workspace made during a reload as expired", async () => {
    let finishList!: () => void;
    vi.mocked(mockTransport.listWorkspaces).mockImplementationOnce(() => new Promise((resolve) => {
      finishList = () => resolve([PROJECT]);
    }));
    const reload = useWorkspaceStore.getState().loadWorkspaces();
    const { hiddenId, placeholder } = await failFirstSend();

    await act(async () => {
      finishList();
      await reload;
    });

    expect(noProjectDrafts()).toEqual([]);
    expect(useWorkspaceStore.getState().threads.map((thread) => thread.id)).toContain(placeholder.id);
    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).toEqual([PROJECT.id, hiddenId]);
  });

  it("lands a first send that finishes after an older reload response", async () => {
    let finishList!: () => void;
    vi.mocked(mockTransport.listWorkspaces).mockImplementationOnce(() => new Promise((resolve) => {
      finishList = () => resolve([PROJECT]);
    }));
    let finishSend!: () => void;
    vi.mocked(mockTransport.createAndSendMessage).mockImplementationOnce((params) => new Promise((resolve) => {
      finishSend = () => resolve({
        ...createMockThread({ id: "thread-created", workspace_id: params.workspaceId }),
        runtimeSnapshot: { threadId: "thread-created", turnExecutionId: "exec-test", phase: "running" },
      });
    }));
    const reload = useWorkspaceStore.getState().loadWorkspaces();
    render(<NewThreadComposer />);
    await typeAndSend();
    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalledOnce());

    await act(async () => {
      finishList();
      await reload;
    });
    await act(async () => finishSend());

    expect(useWorkspaceStore.getState().threads.map((thread) => thread.id)).toEqual(["thread-created"]);
  });

  it("files Edit message on a failed first send under No project, not the hidden workspace", async () => {
    const { placeholder } = await failFirstSend();

    await act(() => editStartupMessage(placeholder, undefined, undefined));

    const [kept] = noProjectDrafts();
    expect(kept?.draft.input).toBe("Build this");
    expect(useWorkspaceStore.getState().activeDraftId).toBe(kept!.id);
    expect(useWorkspaceStore.getState().newThreadTarget).toEqual({ kind: "no-project" });
  });

  it("does not ask for a project before Send, and shows no project-only target rail", async () => {
    render(<NewThreadComposer />);

    await userEvent.setup().type(screen.getByLabelText("Message Mcode"), "Build this");

    expect(screen.getByLabelText("Send message")).toBeEnabled();
    expect(screen.queryByTestId("new-thread-target-rail")).toBeNull();
  });

});
