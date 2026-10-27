import { createMockWorkspace } from "@mcode/contracts/testing";
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ORCHESTRATION_MODES, type GitRef } from "@mcode/contracts";
import { mockTransport } from "@/__tests__/mocks/transport";
import { invalidateBranchTargets } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { rememberComposerMode } from "@/lib/composer-mode-preference";
import { useDiffStore } from "@/stores/diffStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { useThreadDraftStore } from "@/stores/threadDraftStore";
import { INTERACTION_MODES, PERMISSION_MODES } from "@/transport";
import { NewThreadStartColumn } from "../NewThreadStartColumn";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

vi.mock("@/components/chat/lexical", () => ({
  ComposerEditor: ({ editorRef, ariaLabel }: {
    editorRef: React.MutableRefObject<{ update: (fn: () => void) => void; focus: () => void } | null>;
    ariaLabel?: string;
  }) => {
    React.useEffect(() => {
      editorRef.current = { update: vi.fn(), focus: vi.fn() };
    }, [editorRef]);
    return <textarea aria-label={ariaLabel} />;
  },
  $createTypedMentionNode: vi.fn(),
  extractComposerMessage: vi.fn(() => ({ text: "", mentions: [] })),
  insertMentionNode: vi.fn(),
  insertSlashCommandNode: vi.fn(),
}));

vi.mock("@/features/conversation/composer/draft/composer-editor-content", () => ({
  writeComposerContent: vi.fn(),
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
vi.mock("@/components/chat/ContextTracker", () => ({ ContextTracker: () => <div /> }));
vi.mock("@/components/chat/SlashCommandTray", () => ({ SlashCommandTray: () => <div /> }));

const WORKSPACE_ID = "ws-1";
// Wide enough to dock the card (OVERVIEW_DOCK_MIN_CANVAS is 896). jsdom lays nothing out, so every element reports it.
const CANVAS_WIDTH = 1400;

function mainRef(): GitRef {
  return {
    kind: "ref",
    fullName: "refs/heads/main",
    shortName: "main",
    branchName: "main",
    remote: null,
    twin: null,
    isCurrent: true,
    isDefault: true,
    worktree: null,
    headSha: "a".repeat(40),
    committedAt: "2026-10-01T12:00:00.000Z",
  };
}

function seedWorkspace() {
  useWorkspaceStore.setState({
    workspaces: [createMockWorkspace({ id: WORKSPACE_ID, path: "/repo/fixture-repo", is_git_repo: true })],
    activeWorkspaceId: WORKSPACE_ID,
    threads: [],
    activeThreadId: null,
    worktrees: [],
  });
}

function startNewThread() {
  act(() => useWorkspaceStore.getState().beginNewThread(WORKSPACE_ID));
}

function renderColumn() {
  const Column = () => (
    <NewThreadStartColumn
      projectName="fixture-repo"
      workspaceId={WORKSPACE_ID}
      draftId={useWorkspaceStore((state) => state.activeDraftId)}
    />
  );
  return render(<Column />);
}

function toggleOverview(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByTestId("header-overview-toggle"));
}

describe("new-thread Overview", () => {
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
    invalidateBranchTargets(WORKSPACE_ID);
    vi.mocked(mockTransport.listRefs).mockResolvedValue({ ok: true, items: [mainRef()], total: 1, nextCursor: null });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, CANVAS_WIDTH, 900));
    useOverviewStore.setState({ closedSubjects: new Set(), overlaySubject: null, requestedSubject: null });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
    useThreadDraftStore.setState({ drafts: {} });
    rememberComposerMode("worktree");
    seedWorkspace();
    startNewThread();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("docks the card with the new worktree and its base branch, beside the rail", async () => {
    renderColumn();

    const card = await screen.findByTestId("thread-overview-card");
    expect(within(card).getByTestId("overview-target-workspace")).toHaveTextContent("New worktree · Create");
    await waitFor(() => expect(within(card).getByTestId("overview-target-branch")).toHaveTextContent("From main"));
    expect(screen.getByTestId("new-thread-target-rail")).toBeInTheDocument();
    expect(screen.getByTestId("new-thread-start-column")).toHaveStyle({ paddingRight: "328px" });
  });

  it("keeps the rail with the targets while the card is open, closed, and reopened", async () => {
    const user = userEvent.setup();
    renderColumn();
    await screen.findByTestId("thread-overview-card");

    const expectRailTargets = async () => {
      const rail = screen.getByTestId("new-thread-target-rail");
      expect(within(rail).getByTestId("workspace-target-trigger")).toHaveTextContent("New worktree");
      await waitFor(() => expect(within(rail).getByTestId("composer-branch-trigger")).toHaveTextContent("From main"));
    };
    await expectRailTargets();

    await toggleOverview(user);
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
    await expectRailTargets();
    expect(screen.getByTestId("new-thread-start-column").style.paddingRight).toBe("");

    await toggleOverview(user);
    expect(screen.getByTestId("thread-overview-card")).toBeInTheDocument();
    await expectRailTargets();
  });

  it("reopens the card for the next new thread after the user closed it", async () => {
    const user = userEvent.setup();
    renderColumn();
    await screen.findByTestId("thread-overview-card");
    await toggleOverview(user);
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();

    startNewThread();

    expect(await screen.findByTestId("thread-overview-card")).toBeInTheDocument();
    expect(screen.getByTestId("new-thread-target-rail")).toBeInTheDocument();
  });

  it("restores a draft's mode and branch in the card row and the rail", async () => {
    const user = userEvent.setup();
    const draftId = useThreadDraftStore.getState().saveDraft({
      workspaceId: WORKSPACE_ID,
      draft: { input: "draft", mentions: [], selectedTextComments: [], attachments: [], modelId: "gpt-5.5", provider: "codex", reasoning: "high" },
      selection: {
        interactionMode: INTERACTION_MODES.PLAN,
        permissionMode: PERMISSION_MODES.FULL,
        orchestrationMode: ORCHESTRATION_MODES.STANDARD,
        approvalReviewMode: "manual",
        thinking: null,
      },
      target: { mode: "direct", branch: "release/2", branchSource: "branch", branchRemote: null, startFromOrigin: false, selectedWorktree: null },
    });
    if (!draftId) throw new Error("draft was not saved");
    renderColumn();
    await screen.findByTestId("thread-overview-card");
    await toggleOverview(user);

    act(() => useWorkspaceStore.getState().openThreadDraft(WORKSPACE_ID, draftId));

    const card = await screen.findByTestId("thread-overview-card");
    expect(within(card).getByTestId("overview-target-workspace")).toHaveTextContent("Local · fixture-repo");
    expect(within(card).getByTestId("overview-target-branch")).toHaveTextContent("On release/2");

    await toggleOverview(user);
    const rail = screen.getByTestId("new-thread-target-rail");
    expect(within(rail).getByTestId("workspace-target-trigger")).toHaveTextContent("Local");
    expect(within(rail).getByTestId("composer-branch-trigger")).toHaveTextContent("On release/2");
  });

  it("switches the workspace from the row's Workspace menu", async () => {
    const user = userEvent.setup();
    renderColumn();
    const card = await screen.findByTestId("thread-overview-card");
    const row = within(card).getByTestId("overview-target-workspace");

    await user.click(row);
    expect(await screen.findByRole("group", { name: "Workspace" })).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("menuitemradio", { name: /Local/ }));

    expect(within(card).getByTestId("overview-target-workspace")).toHaveTextContent("Local · fixture-repo");
    await waitFor(() => expect(within(card).getByTestId("overview-target-branch")).toHaveTextContent("On main"));
    expect(useWorkspaceStore.getState().newThreadMode).toBe("direct");
  });

  it("shows a static Local row and no branch row outside a git repo", async () => {
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: WORKSPACE_ID, path: "/repo/fixture-repo", is_git_repo: false })],
    });
    renderColumn();

    const card = await screen.findByTestId("thread-overview-card");
    const row = within(card).getByTestId("overview-target-workspace");
    expect(row).toHaveTextContent("Local · fixture-repo");
    expect(row.tagName).toBe("DIV");
    expect(within(card).queryByTestId("overview-target-branch")).not.toBeInTheDocument();
  });
});
