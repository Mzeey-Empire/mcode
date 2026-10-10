import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { GitRef } from "@mcode/contracts";

import { installListboxLayout } from "@/__tests__/helpers/picker-layout";
import { invalidateBranchTargets } from "@/features/conversation/composer/execution/targets/useBranchTargets";

const { mockGeneratePrDraft, mockListRefs } = vi.hoisted(() => ({
  mockGeneratePrDraft: vi.fn(),
  mockListRefs: vi.fn(),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: { getState: vi.fn(() => ({ recordPrCreated: vi.fn() })) },
}));

vi.mock("@/stores/toastStore", () => ({
  useToastStore: {
    getState: vi.fn(() => ({ show: vi.fn() })),
  },
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({
    createPr: vi.fn(),
    generatePrDraft: mockGeneratePrDraft,
    listRefs: mockListRefs,
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render }: { render: ReactElement }) => render,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownContent", () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { CreatePrDialog } from "./CreatePrDialog";

installListboxLayout();

function gitRef(shortName: string, overrides: Partial<GitRef> = {}): GitRef {
  return {
    kind: "ref",
    fullName: `refs/heads/${shortName}`,
    shortName,
    branchName: shortName,
    remote: null,
    twin: null,
    isCurrent: false,
    isDefault: false,
    worktree: null,
    headSha: "a".repeat(40),
    committedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function refsPage(items: GitRef[]) {
  return { ok: true, items, total: items.length, nextCursor: null };
}

function renderDialog(preferredBaseBranch?: string) {
  return render(
    <CreatePrDialog
      open
      onOpenChange={vi.fn()}
      threadId="thread-1"
      workspaceId="ws-1"
      branch="feat/issue-801"
      preferredBaseBranch={preferredBaseBranch}
    />,
  );
}

function option(name: RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

beforeEach(() => {
  invalidateBranchTargets("ws-1");
  mockGeneratePrDraft.mockReset().mockResolvedValue({ title: "Draft title", body: "Draft body" });
  mockListRefs.mockReset().mockResolvedValue(refsPage([
    gitRef("feat/issue-801", { isCurrent: true }),
    gitRef("main", { isDefault: true }),
    gitRef("release"),
  ]));
});

describe("CreatePrDialog base branch", () => {
  it("uses the preferred base initially without overriding later user selection", async () => {
    renderDialog("main");

    const basePicker = screen.getByRole("button", { name: "Base branch" });
    expect(basePicker).toHaveTextContent("main");

    fireEvent.click(await screen.findByRole("option", { name: /release/ }));

    await waitFor(() => {
      expect(basePicker).toHaveTextContent("release");
    });
  });

  it("generates an initial draft when the dialog opens with an empty form", async () => {
    renderDialog("main");

    await waitFor(() => {
      expect(mockGeneratePrDraft).toHaveBeenCalledWith("ws-1", "thread-1", "main");
    });
    expect(await screen.findByDisplayValue("Draft title")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Draft body")).toBeInTheDocument();
    expect(mockGeneratePrDraft).toHaveBeenCalledTimes(1);
  });

  it("announces draft generation status while the initial draft is loading", async () => {
    mockGeneratePrDraft.mockImplementation(() => new Promise(() => {}));
    renderDialog("main");

    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Generating PR draft");
  });

  it("opens on the repository default, not the checked-out head, once the branch list names it", async () => {
    let releasePage = () => {};
    const pageHeld = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    mockListRefs.mockImplementation(async () => {
      await pageHeld;
      return refsPage([gitRef("feat/issue-801", { isCurrent: true }), gitRef("trunk", { isDefault: true })]);
    });
    renderDialog();

    const basePicker = screen.getByRole("button", { name: "Base branch" });
    expect(basePicker).toHaveTextContent("Loading branches");
    expect(mockGeneratePrDraft).not.toHaveBeenCalled();

    releasePage();

    await waitFor(() => expect(basePicker).toHaveTextContent("trunk"));
    await waitFor(() => expect(mockGeneratePrDraft).toHaveBeenCalledWith("ws-1", "thread-1", "trunk"));
    expect(mockGeneratePrDraft).toHaveBeenCalledTimes(1);
  });

  it("rules out the head branch as its own base", async () => {
    renderDialog("main");

    await screen.findByRole("option", { name: /release/ });
    const head = option(/feat\/issue-801/);
    expect(head).toHaveAttribute("aria-disabled", "true");
    expect(head).toHaveAccessibleDescription("Head branch");

    fireEvent.click(head);

    expect(screen.getByRole("button", { name: "Base branch" })).toHaveTextContent("main");
  });

  it("asks for a base when the repository names no default, and drafts once one is picked", async () => {
    mockListRefs.mockResolvedValue(refsPage([gitRef("feat/issue-801", { isCurrent: true }), gitRef("release")]));
    renderDialog();

    const basePicker = screen.getByRole("button", { name: "Base branch" });
    await waitFor(() => expect(basePicker).toHaveTextContent("Choose branch"));
    expect(basePicker).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(mockGeneratePrDraft).not.toHaveBeenCalled();

    fireEvent.click(option(/release/));

    await waitFor(() => expect(basePicker).toHaveTextContent("release"));
    await waitFor(() => expect(mockGeneratePrDraft).toHaveBeenCalledWith("ws-1", "thread-1", "release"));
  });
});
