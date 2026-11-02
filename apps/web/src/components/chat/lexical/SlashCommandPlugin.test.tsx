import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
/**
 * Keyboard-only coverage for `/plan` in the real Composer: the live Lexical
 * editor, slash plugin, slash command hook, tray, and Plan chip are all wired
 * together, so each assertion reads what the user would see.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  $getRoot,
  $getSelection,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  getNearestEditorFromDOMNode,
} from "lexical";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/features/conversation/composer/Composer";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { mockTransport } from "@/__tests__/mocks/transport";

const capabilityGate = vi.hoisted(() => ({ planOffered: true }));

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

// Every shipped provider offers Plan today, so a provider without it is simulated here.
vi.mock("@/features/conversation/composer/composer-capabilities", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/conversation/composer/composer-capabilities")
  >("@/features/conversation/composer/composer-capabilities");
  return {
    ...actual,
    resolveComposerCapabilities: (
      options: Parameters<typeof actual.resolveComposerCapabilities>[0],
    ) =>
      actual
        .resolveComposerCapabilities(options)
        .filter((capability) => capabilityGate.planOffered || capability.id !== "plan"),
  };
});

vi.mock("@/components/chat/ModelSelector", () => ({ ModelSelector: () => <div /> }));
vi.mock("@/components/chat/SpellcheckContextMenu", () => ({ SpellcheckContextMenu: () => <div /> }));
vi.mock("@/components/chat/ComposerQueueList", () => ({ ComposerQueueList: () => <div /> }));

const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalRangeRect = Range.prototype.getBoundingClientRect;

beforeAll(() => {
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.scrollIntoView = () => {};
  // Lexical measures the caret range after each edit; jsdom has no layout for ranges.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterAll(() => {
  if (originalResizeObserver === undefined) {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  } else {
    globalThis.ResizeObserver = originalResizeObserver;
  }
  Element.prototype.scrollIntoView = originalScrollIntoView;
  Range.prototype.getBoundingClientRect = originalRangeRect;
});

function seedThread() {
  const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
  const thread = createMockThread({ id: "thread-1", workspace_id: workspace.id, mode: "direct", provider: "claude" });
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

async function renderComposer() {
  render(<Composer threadId="thread-1" workspaceId="ws-1" />);
  const editorElement = await screen.findByRole("textbox", { name: "Message Mcode" });
  const editor = getNearestEditorFromDOMNode(editorElement);
  if (!editor) throw new Error("composer textbox is not a Lexical editor");
  const user = userEvent.setup();
  await user.click(editorElement);
  await act(async () => {
    editor.update(() => {
      if (!$getSelection()) $getRoot().selectEnd();
    }, { discrete: true });
  });

  /**
   * Types one character at a time through Lexical's own text-insertion command,
   * which is what its beforeinput handler dispatches in a browser. jsdom does not
   * implement the beforeinput path, so user-event text never reaches the editor.
   * Named keys (Enter, Tab) still go through user-event as real keydown events.
   */
  async function type(text: string) {
    for (const character of text) {
      await act(async () => {
        editor?.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, character);
      });
    }
  }

  return { editor: editorElement, user, type };
}

function planMode() {
  return screen.queryByRole("button", { name: "Remove Plan" });
}

function goalMode() {
  return screen.queryByRole("button", { name: "Remove Goal" });
}

function slashTray() {
  return screen.queryByRole("listbox", { name: "Slash commands" });
}

describe("SlashCommandPlugin /plan in the composer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capabilityGate.planOffered = true;
    resetThreadStoreForTests({ runningThreadIds: new Set() });
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    seedThread();
  });

  it("lists /plan with Enter plan mode while typing /pl", async () => {
    const { type } = await renderComposer();

    await type("/pl");

    const tray = await waitFor(() => {
      const listbox = slashTray();
      if (!listbox) throw new Error("slash tray not open");
      return listbox;
    });
    const row = within(tray).getByRole("option", { name: /^\/plan Enter plan mode/ });
    expect(row).toHaveTextContent("/plan");
    expect(row).toHaveTextContent("Enter plan mode");
    expect(planMode()).toBeNull();
  });

  it.each(["{Enter}", "{Tab}"])("removes /pl and turns Plan on with %s", async (key) => {
    const { editor, user, type } = await renderComposer();

    await type("/pl");
    await screen.findByRole("option", { name: /^\/plan Enter plan mode/ });
    await user.keyboard(key);

    await waitFor(() => expect(planMode()).toBeInTheDocument());
    expect(editor.textContent ?? "").not.toContain("/pl");
    expect(slashTray()).toBeNull();
  });

  it("turns Plan on and keeps the prompt when /plan is typed inline", async () => {
    const { editor, type } = await renderComposer();

    await type("/plan fix the menu");

    await waitFor(() => expect(planMode()).toBeInTheDocument());
    expect(editor).toHaveTextContent(/^fix the menu$/);
  });

  it("offers Exit plan mode while Plan is on and turns it off on Enter", async () => {
    const { editor, user, type } = await renderComposer();
    await type("/plan ");
    await waitFor(() => expect(planMode()).toBeInTheDocument());

    await type("/pl");
    await screen.findByRole("option", { name: /^\/plan Exit plan mode/ });
    await user.keyboard("{Enter}");

    await waitFor(() => expect(planMode()).toBeNull());
    expect(editor.textContent ?? "").not.toContain("/pl");
  });

  it("keeps the draft while Plan toggles on and off", async () => {
    const { editor, user, type } = await renderComposer();
    await type("fix the menu ");

    await type("/pl");
    await screen.findByRole("option", { name: /^\/plan Enter plan mode/ });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(planMode()).toBeInTheDocument());
    expect(editor).toHaveTextContent(/^fix the menu\s*$/);

    await type("/pl");
    await screen.findByRole("option", { name: /^\/plan Exit plan mode/ });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(planMode()).toBeNull());
    expect(editor).toHaveTextContent(/^fix the menu\s*$/);
  });

  it("leaves unknown commands literal", async () => {
    const { editor, type } = await renderComposer();

    await type("/foo bar");

    expect(editor).toHaveTextContent(/^\/foo bar$/);
    expect(planMode()).toBeNull();
  });

  it("leaves /plan literal when the provider does not offer Plan", async () => {
    capabilityGate.planOffered = false;
    const { editor, type } = await renderComposer();

    await type("/plan fix the menu");

    expect(editor).toHaveTextContent(/^\/plan fix the menu$/);
    expect(planMode()).toBeNull();
  });

  it("turns Goal on and removes the text when /goal is typed inline", async () => {
    const { editor, type } = await renderComposer();

    await type("/goal ");

    await waitFor(() => expect(goalMode()).toBeInTheDocument());
    expect(editor.textContent ?? "").not.toContain("/goal");
  });

  it("keeps Goal on when /goal is picked while a goal is pending", async () => {
    const { user, type } = await renderComposer();
    await type("/goal ");
    await waitFor(() => expect(goalMode()).toBeInTheDocument());

    await type("/goa");
    await screen.findByRole("option", { name: /^\/goal / });
    await user.keyboard("{Enter}");

    await waitFor(() => expect(slashTray()).toBeNull());
    expect(goalMode()).toBeInTheDocument();
  });

  it("closes on Escape, keeps the text, and stays closed while the word grows", async () => {
    const { editor, user, type } = await renderComposer();
    await type("/pl");
    await waitFor(() => expect(slashTray()).toBeInTheDocument());

    await user.keyboard("{Escape}");
    await type("a");

    expect(slashTray()).toBeNull();
    expect(editor).toHaveTextContent(/^\/pla$/);

    await type(" /co");
    await waitFor(() => expect(slashTray()).toBeInTheDocument());
  });

  it("makes the tray's remove buttons inert while the menu covers it", async () => {
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
    const { type } = await renderComposer();
    const remove = screen.getByRole("button", { name: "Remove notes.txt" });
    expect(remove.closest("[inert]")).toBeNull();

    await type("/");
    await waitFor(() => expect(slashTray()).toBeInTheDocument());

    expect(remove.closest("[inert]")).not.toBeNull();
  });
});
