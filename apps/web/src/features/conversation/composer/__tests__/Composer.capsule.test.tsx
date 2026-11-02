import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { mockTransport } from "@/__tests__/mocks/transport";

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
vi.mock("@/components/chat/ComposerQueueList", () => ({ ComposerQueueList: () => <div /> }));
vi.mock("@/components/chat/ContextTracker", () => ({ ContextTracker: () => <div /> }));
vi.mock("@/components/chat/SlashCommandTray", () => ({ SlashCommandTray: () => <div /> }));

function seedCodexThread(overrides: Partial<ReturnType<typeof createMockThread>> = {}) {
  const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
  const thread = createMockThread({ id: "thread-1", workspace_id: workspace.id, mode: "direct", provider: "codex", ...overrides });
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

async function pickFromAddMenu(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("button", { name: "Add to composer" }));
  await user.click(await screen.findByRole("menuitemcheckbox", { name }));
}

describe("Composer capsule", () => {
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
    seedCodexThread();
  });

  it("shows an attached file as a tile in the tray, outside the capsule", async () => {
    useComposerDraftStore.setState({
      drafts: {
        "thread-1": {
          input: "",
          attachments: [{ id: "file-1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 2048, previewUrl: "", filePath: "/tmp/notes.txt" }],
          modelId: "",
          reasoning: "medium",
        },
      },
      pendingPrefill: null,
    });
    render(<Composer threadId="thread-1" workspaceId="ws-1" />);

    const remove = await screen.findByRole("button", { name: "Remove notes.txt" });
    expect(screen.getByTestId("composer-tray")).toContainElement(remove);
    expect(screen.getByTestId("composer-surface")).not.toContainElement(remove);
  });

  it("shows Plan by name beside +, and Remove turns it off", async () => {
    const user = userEvent.setup();
    render(<Composer threadId="thread-1" workspaceId="ws-1" />);

    await pickFromAddMenu(user, /Plan/);

    const plan = await screen.findByTestId("composer-mode-plan");
    expect(screen.getByTestId("composer-modes")).toContainElement(plan);
    expect(plan).toHaveTextContent("Plan");

    await user.click(screen.getByRole("button", { name: "Remove Plan" }));

    await waitFor(() => expect(screen.queryByTestId("composer-mode-plan")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Add to composer" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Plan/ })).toHaveAttribute("aria-checked", "false");
  });

  it("renders Plan and Goal as two modes, each a tooltip trigger", async () => {
    const user = userEvent.setup();
    render(<Composer threadId="thread-1" workspaceId="ws-1" />);

    await pickFromAddMenu(user, /Plan/);
    await screen.findByTestId("composer-mode-plan");
    await pickFromAddMenu(user, /Goal/);

    const goal = await screen.findByTestId("composer-mode-goal");
    const plan = screen.getByTestId("composer-mode-plan");
    for (const mode of [plan, goal]) {
      expect(mode).toHaveAttribute("data-slot", "tooltip-trigger");
    }
  });

  it("turns Goal off when it is picked again from the + menu", async () => {
    const user = userEvent.setup();
    render(<Composer threadId="thread-1" workspaceId="ws-1" />);

    await pickFromAddMenu(user, /Goal/);
    await screen.findByTestId("composer-mode-goal");
    await pickFromAddMenu(user, /Goal/);

    await waitFor(() => expect(screen.queryByTestId("composer-mode-goal")).not.toBeInTheDocument());
  });

  it("keeps Ultra checked but not choosable in the + menu once it is on, since only its chip turns it off", async () => {
    const user = userEvent.setup();
    seedCodexThread({ model: "gpt-6.1-sol" });
    render(<Composer threadId="thread-1" workspaceId="ws-1" />);

    await pickFromAddMenu(user, /Ultra/);
    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    const ultra = await screen.findByRole("menuitemcheckbox", { name: /Ultra/ });
    expect(ultra).toHaveAttribute("aria-checked", "true");
    expect(ultra).toHaveAttribute("aria-disabled", "true");
  });
});
