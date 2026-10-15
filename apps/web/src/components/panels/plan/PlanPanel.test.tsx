import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanImplement, PlanImplementReceipt, PlanSaveVersion, PlanVersion, ReviewState } from "@mcode/contracts";
import { createMockThread } from "@/__tests__/mocks/transport";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { usePlanStore } from "@/stores/planStore";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { RpcError } from "@/transport/ws-transport";
import { executeCommand, getCommand } from "@/lib/command-registry";
import { usePlanCommands } from "./use-plan-commands";
import { PlanPanel, planEditorAccess } from "./PlanPanel";
import { planSaveScheduler } from "./plan-draft-sessions";
import { IMPLEMENT_FAILED_NOTICE, PLAN_CHANGED_NOTICE, implementPlan as implementPlanAction, usePlanImplementStore } from "./plan-implement";

const savePlanVersion = vi.hoisted(() => vi.fn<(payload: PlanSaveVersion) => Promise<PlanVersion>>());
const implementPlan = vi.hoisted(() => vi.fn<(payload: PlanImplement) => Promise<PlanImplementReceipt>>());
const getReviewState = vi.hoisted(() => vi.fn<() => Promise<ReviewState>>());
vi.mock("@/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transport")>()),
  getTransport: () => ({
    savePlanVersion,
    implementPlan,
    getReviewState,
    updateThreadSettings: vi.fn(async () => true),
    touchLastOpened: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => useWorkspaceStore.getState().threads),
  }),
}));

const THREAD = "thread-plan";

function reviewState(uncommitted: number): ReviewState {
  return {
    isGitRepo: true, head: "a".repeat(40), branch: "main", uncommitted: { staged: 0, unstaged: uncommitted, untracked: 0 },
    commitsAhead: null, branchDefault: { unavailable: "no-base" },
  };
}

function makePlan(version: number, overrides: Partial<PlanVersion> = {}): PlanVersion {
  return {
    id: `plan-${version}`,
    threadId: THREAD,
    messageId: `message-${version}`,
    version,
    title: `Version ${version} Plan`,
    contentMd: `# Version ${version} Plan\n\nSummary ${version}.\n\n## Steps\n\n1. Step for v${version}\n`,
    author: "agent",
    providerId: "codex",
    captureSource: "fence",
    baseVersionId: null,
    revision: 0,
    acceptedAt: null,
    acceptedMessageId: null,
    status: "ready",
    createdAt: `2026-05-23T00:00:0${version}.000Z`,
    updatedAt: `2026-05-23T00:00:0${version}.000Z`,
    ...overrides,
  };
}

function editorText(): string {
  return document.querySelector(".cm-content")?.textContent ?? "";
}

function isEditable(): boolean {
  return document.querySelector(".cm-content")?.getAttribute("contenteditable") === "true";
}

function typeAtEnd(text: string): void {
  const host = document.querySelector<HTMLElement>(".cm-editor");
  const view = host ? EditorView.findFromDOM(host) : null;
  if (!view) throw new Error("Plan editor is not mounted");
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: "input.type" }));
}

describe("PlanPanel", () => {
  beforeEach(() => {
    usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {}, pendingImplementByThread: {} });
    useComposerDraftStore.setState({ drafts: {} });
    useThreadStore.setState({ runningThreadIds: new Set() });
    savePlanVersion.mockReset();
    implementPlan.mockReset();
    getReviewState.mockReset();
    getReviewState.mockResolvedValue(reviewState(0));
    useWorkspaceStore.setState({ threads: [], activeThreadId: null });
    usePlanImplementStore.setState({ notices: {}, busy: {} });
    useConnectionStore.setState({ status: "connected" });
  });

  it("shows the latest version and names it in the picker", () => {
    usePlanStore.setState({
      plansByThread: { [THREAD]: [makePlan(1, { status: "superseded" }), makePlan(2)] },
    });

    render(<PlanPanel threadId={THREAD} />);

    expect(editorText()).toContain("Version 2 Plan");
    expect(editorText()).toContain("Step for v2");
    expect(editorText()).not.toContain("#");
    expect(screen.getByTestId("plan-version-picker")).toHaveTextContent("v2Codex");
  });

  it("shows an older version's content after it is picked", async () => {
    usePlanStore.setState({
      plansByThread: { [THREAD]: [makePlan(1, { status: "superseded" }), makePlan(2)] },
    });
    render(<PlanPanel threadId={THREAD} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("plan-version-picker"));
    const rows = await screen.findAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["v2 Codex", "v1 Older version"]);
    await user.click(screen.getByRole("menuitemradio", { name: "v1 Older version" }));

    expect(usePlanStore.getState().activeVersionByThread[THREAD]).toBe(1);
    await waitFor(() => expect(editorText()).toContain("Step for v1"));
    expect(editorText()).not.toContain("Step for v2");
    expect(screen.getByTestId("plan-version-picker")).toHaveTextContent("v1Older version");
  });

  it("reopens on the version an unfinished comment note was written on", () => {
    const first = makePlan(1, { status: "superseded" });
    usePlanStore.setState({ plansByThread: { [THREAD]: [first, makePlan(2)] } });
    const anchor = { kind: "text", start: 2, end: 6, quote: "Plan", prefix: "", suffix: "", section: null } as const;
    useComposerDraftStore.getState().updateNextMessage(THREAD, (draft) => ({
      ...draft,
      planCommentEditor: { planVersionId: first.id, commentId: null, anchor, body: "half" },
    }));

    render(<PlanPanel threadId={THREAD} />);

    expect(usePlanStore.getState().activeVersionByThread[THREAD]).toBe(1);
  });

  it("reads Accepted for an accepted version and offers no Implement action", () => {
    usePlanStore.setState({
      plansByThread: { [THREAD]: [makePlan(1, { status: "accepted", acceptedAt: "2026-05-24T00:00:00.000Z" })] },
    });

    render(<PlanPanel threadId={THREAD} />);

    expect(screen.getByTestId("plan-version-picker")).toHaveTextContent("v1Accepted");
    expect(screen.queryByRole("button", { name: /implement/i })).toBeNull();
  });

  it("renders nothing when the thread has no plan", () => {
    const { container } = render(<PlanPanel threadId={THREAD} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("edits only the latest draft or ready version while no turn runs", async () => {
    usePlanStore.setState({ plansByThread: { [THREAD]: [makePlan(1, { status: "superseded" }), makePlan(2)] } });
    const { rerender } = render(<PlanPanel threadId={THREAD} />);
    expect(isEditable()).toBe(true);

    act(() => useThreadStore.setState({ runningThreadIds: new Set([THREAD]) }));
    rerender(<PlanPanel threadId={THREAD} />);
    expect(isEditable()).toBe(false);

    act(() => useThreadStore.setState({ runningThreadIds: new Set() }));
    act(() => usePlanStore.getState().setActiveVersion(THREAD, 1));
    await waitFor(() => expect(editorText()).toContain("Step for v1"));
    expect(isEditable()).toBe(false);
  });

  it("keeps an accepted version read-only", () => {
    usePlanStore.setState({
      plansByThread: { [THREAD]: [makePlan(1, { status: "accepted", acceptedAt: "2026-05-24T00:00:00.000Z" })] },
    });

    render(<PlanPanel threadId={THREAD} />);

    expect(isEditable()).toBe(false);
  });

  it("saves typed text as a fork of the latest ready version", async () => {
    const thread = "thread-plan-typing";
    const ready = makePlan(2, { id: "00000000-0000-4000-8000-000000000002" });
    usePlanStore.setState({ plansByThread: { [thread]: [ready] } });
    savePlanVersion.mockImplementation(async (payload) =>
      makePlan(3, { id: payload.versionId, status: "draft", author: "user", revision: 1, contentMd: payload.contentMd }));
    render(<PlanPanel threadId={thread} />);

    typeAtEnd("Extra");

    await waitFor(() => expect(savePlanVersion).toHaveBeenCalledTimes(1));
    expect(savePlanVersion.mock.calls[0][0]).toMatchObject({
      threadId: thread,
      baseVersionId: ready.id,
      baseRevision: 0,
      contentMd: `${ready.contentMd}Extra`,
    });
    await waitFor(() => expect(screen.getByTestId("plan-version-picker")).toHaveTextContent("v3Edited by you"));
  });

  it("follows the new draft when the edited version was picked explicitly", async () => {
    const thread = "thread-plan-picked";
    const ready = makePlan(2, { id: "00000000-0000-4000-8000-000000000002" });
    usePlanStore.setState({ plansByThread: { [thread]: [ready] }, activeVersionByThread: { [thread]: 2 } });
    savePlanVersion.mockImplementation(async (payload) =>
      makePlan(3, { id: payload.versionId, status: "draft", author: "user", revision: 1, contentMd: payload.contentMd }));
    render(<PlanPanel threadId={thread} />);

    typeAtEnd("Extra");

    await waitFor(() => expect(screen.getByTestId("plan-version-picker")).toHaveTextContent("v3Edited by you"));
    expect(editorText()).toContain("Extra");
    expect(isEditable()).toBe(true);
  });

  it("holds local text on conflict until Use saved version shows the saved text", async () => {
    const thread = "thread-plan-conflict";
    const ready = makePlan(2, { id: "00000000-0000-4000-8000-000000000002" });
    const theirs = makePlan(3, { id: "00000000-0000-4000-8000-0000000000b1", status: "draft", author: "user",
      revision: 1, baseVersionId: ready.id, contentMd: "# Their plan\n" });
    usePlanStore.setState({ plansByThread: { [thread]: [ready] } });
    savePlanVersion.mockRejectedValue(new RpcError("Plan changed", "plan_conflict", { latestVersion: theirs }));
    render(<PlanPanel threadId={thread} />);
    const user = userEvent.setup();

    act(() => {
      planSaveScheduler(thread).edit("# My plan\n", ready);
      planSaveScheduler(thread).flush();
    });

    expect(await screen.findByTestId("plan-conflict-notice")).toHaveTextContent("This plan changed in another window.");
    expect(screen.getByRole("button", { name: "Keep my text" })).toBeInTheDocument();
    expect(editorText()).toContain("My plan");
    expect(isEditable()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Use saved version" }));

    expect(screen.queryByTestId("plan-conflict-notice")).toBeNull();
    await waitFor(() => expect(editorText()).toContain("Their plan"));
    expect(isEditable()).toBe(true);
  });

  it("offers only Use saved version when the latest version is accepted", async () => {
    const thread = "thread-plan-accepted-conflict";
    const ready = makePlan(2, { id: "00000000-0000-4000-8000-000000000002" });
    const accepted = { ...ready, status: "accepted" as const, acceptedAt: "2026-05-24T00:00:00.000Z" };
    usePlanStore.setState({ plansByThread: { [thread]: [ready] } });
    savePlanVersion.mockRejectedValue(new RpcError("Read only", "plan_read_only", { latestVersion: accepted }));
    render(<PlanPanel threadId={thread} />);

    act(() => {
      planSaveScheduler(thread).edit("# My plan\n", ready);
      planSaveScheduler(thread).flush();
    });

    await screen.findByTestId("plan-conflict-notice");
    expect(screen.queryByRole("button", { name: "Keep my text" })).toBeNull();
    expect(screen.getByRole("button", { name: "Use saved version" })).toBeInTheDocument();
    expect(editorText()).toContain("My plan");
  });

  describe("Implement", () => {
    const READY_ID = "00000000-0000-4000-8000-000000000002";

    function receiptFor(request: PlanImplement): PlanImplementReceipt {
      return { requestId: request.requestId, versionId: request.versionId, version: 2, targetThreadId: request.threadId,
        messageId: "00000000-0000-4000-8000-0000000000c1", nativePlanFile: null, state: "admitted" };
    }

    function theirDraft(): PlanVersion {
      return makePlan(3, { id: "00000000-0000-4000-8000-0000000000b1", status: "draft", author: "user",
        revision: 1, baseVersionId: READY_ID, contentMd: "# Their plan\n" });
    }

    async function pressImplement(label: string): Promise<void> {
      await userEvent.setup().click(screen.getByRole("button", { name: label }));
    }

    function startInPlan(thread: string, versions: PlanVersion[]): void {
      usePlanStore.setState({ plansByThread: { [thread]: versions } });
      useThreadStore.getState().applyPersistedThreadSettings(thread, { interactionMode: "plan" });
    }

    function interactionMode(thread: string): string {
      return useThreadStore.getState().getThreadSettings(thread).interactionMode;
    }

    it.each(["thread", "new-thread"] as const)("implements through the menu with target %s", async (target) => {
      const thread = `thread-menu-${target}`;
      startInPlan(thread, [makePlan(2, { id: READY_ID })]);
      implementPlan.mockImplementation(async (request) => ({ ...receiptFor(request), targetThreadId: "implemented-thread" }));
      render(<PlanPanel threadId={thread} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "More ways to implement" }));
      const label = target === "thread" ? "Implement v2" : "Implement v2 in a new thread";
      await user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${label}(?:$|\\s*(?:Ctrl|⌘))`) }));
      await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(1));
      expect(implementPlan.mock.calls[0][0]).toMatchObject({ threadId: thread, versionId: READY_ID, expectedRevision: 0, target });
      await waitFor(() => expect(interactionMode(thread)).toBe("build"));
      if (target === "new-thread") expect(useWorkspaceStore.getState().activeThreadId).toBe("implemented-thread");
    });

    it.each(["thread", "new-thread"] as const)("implements through the palette with target %s and unregisters on history", async (target) => {
      const thread = `thread-palette-${target}`;
      startInPlan(thread, [makePlan(2, { id: READY_ID })]);
      implementPlan.mockImplementation(async (request) => ({ ...receiptFor(request), targetThreadId: "palette-thread" }));
      const hook = renderHook(() => usePlanCommands(thread));
      const command = target === "thread" ? "plan.implement" : "plan.implementInNewThread";
      expect(getCommand(command)?.title).toBe(target === "thread" ? "Implement v2" : "Implement v2 in a new thread");
      act(() => { expect(executeCommand(command)).toBe(true); });
      await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(1));
      expect(implementPlan.mock.calls[0][0]).toMatchObject({ threadId: thread, versionId: READY_ID, expectedRevision: 0, target });
      await waitFor(() => expect(interactionMode(thread)).toBe("build"));
      act(() => usePlanStore.setState({ plansByThread: { [thread]: [makePlan(2, { id: READY_ID, status: "accepted" })] } }));
      expect(executeCommand("plan.implement")).toBe(false);
      expect(executeCommand("plan.implementInNewThread")).toBe(false);
      hook.unmount();
    });

    it.each([false, true])("replays a new-thread request once and opens only its receipt target, second drop: %s", async (secondDrop) => {
      const thread = `thread-new-implement-${secondDrop}`;
      startInPlan(thread, [makePlan(2, { id: READY_ID })]);
      useWorkspaceStore.setState({ activeThreadId: thread, threads: [] });
      implementPlan.mockImplementationOnce(async () => {
        useConnectionStore.setState({ status: "reconnecting" });
        throw new Error("WebSocket disconnected");
      });
      implementPlan.mockImplementationOnce(async (request) => {
        if (secondDrop) throw new Error("WebSocket disconnected");
        return { ...receiptFor(request), targetThreadId: "new-implementation-thread" };
      });
      const pending = implementPlanAction(thread, "new-thread");
      await waitFor(() => expect(useConnectionStore.getState().status).toBe("reconnecting"));
      act(() => useConnectionStore.setState({ status: "connected" }));
      await act(async () => pending);
      expect(implementPlan.mock.calls).toHaveLength(2);
      expect(implementPlan.mock.calls[1][0]).toEqual(implementPlan.mock.calls[0][0]);
      expect(implementPlan.mock.calls[0][0].target).toBe("new-thread");
      if (secondDrop) {
        expect(useWorkspaceStore.getState().activeThreadId).toBe(thread);
        expect(usePlanImplementStore.getState().notices[thread]).toBe(IMPLEMENT_FAILED_NOTICE);
        expect(interactionMode(thread)).toBe("plan");
      } else {
        expect(useWorkspaceStore.getState().activeThreadId).toBe("new-implementation-thread");
        expect(interactionMode(thread)).toBe("build");
      }
    });

    describe("in a new worktree", () => {
      const SOURCE = "thread-worktree-source";
      const TARGET = "thread-worktree-target";

      function seedThreads(): void {
        useWorkspaceStore.setState({
          threads: [
            createMockThread({ id: SOURCE, workspace_id: "workspace-1" }),
            createMockThread({ id: TARGET, workspace_id: "workspace-1", mode: "worktree", worktree_path: "F:\\repo\\.mcode\\worktrees\\main-4f3a2b1c" }),
          ],
        });
      }

      function waitingReceipt(request: PlanImplement): PlanImplementReceipt {
        return { ...receiptFor(request), targetThreadId: TARGET, state: "waiting-for-setup" };
      }

      async function openMenu(): Promise<ReturnType<typeof userEvent.setup>> {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "More ways to implement" }));
        return user;
      }

      it("starts the request from the third item and opens the new thread", async () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        implementPlan.mockImplementation(async (request) => ({ ...receiptFor(request), targetThreadId: TARGET }));
        render(<PlanPanel threadId={SOURCE} />);

        const user = await openMenu();
        await user.click(await screen.findByRole("menuitem", { name: "Implement v2 in a new worktree" }));

        await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(1));
        expect(implementPlan.mock.calls[0][0]).toMatchObject({ threadId: SOURCE, target: "new-worktree" });
        await waitFor(() => expect(useWorkspaceStore.getState().activeThreadId).toBe(TARGET));
        expect(interactionMode(SOURCE)).toBe("build");
      });

      it("says uncommitted changes stay behind only when the source has some", async () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        getReviewState.mockResolvedValue(reviewState(3));
        render(<PlanPanel threadId={SOURCE} />);

        await openMenu();
        const item = await screen.findByRole("menuitem", { name: /in a new worktree/ });
        expect(item).toHaveTextContent("Starts from the last commit. Uncommitted changes stay here.");
      });

      it("shows no second line for a clean source", async () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        render(<PlanPanel threadId={SOURCE} />);

        await openMenu();
        const item = await screen.findByRole("menuitem", { name: /in a new worktree/ });
        expect(item).not.toHaveTextContent("Uncommitted");
      });

      it("offers neither the item nor the command outside a git repository", async () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        getReviewState.mockResolvedValue({ isGitRepo: false });
        const hook = renderHook(() => usePlanCommands(SOURCE));
        render(<PlanPanel threadId={SOURCE} />);

        await openMenu();
        await screen.findByRole("menuitem", { name: "Implement v2 in a new thread" });
        expect(screen.queryByRole("menuitem", { name: /in a new worktree/ })).toBeNull();
        expect(getCommand("plan.implementInNewWorktree")).toBeUndefined();
        expect(getCommand("plan.implementInNewThread")).toBeDefined();
        hook.unmount();
      });

      it("registers the palette command in a git repository", async () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        implementPlan.mockImplementation(async (request) => ({ ...receiptFor(request), targetThreadId: TARGET }));
        const hook = renderHook(() => usePlanCommands(SOURCE));

        await waitFor(() => expect(getCommand("plan.implementInNewWorktree")?.title).toBe("Implement v2 in a new worktree"));
        act(() => { expect(executeCommand("plan.implementInNewWorktree")).toBe(true); });
        await waitFor(() => expect(implementPlan.mock.calls[0]?.[0]).toMatchObject({ target: "new-worktree" }));
        hook.unmount();
      });

      it("holds the source in Plan, read-only, until the server reports the first turn admitted", async () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        implementPlan.mockImplementation(async (request) => waitingReceipt(request));
        render(<PlanPanel threadId={SOURCE} />);

        await pressImplement("Implement v2");

        const notice = await screen.findByTestId("plan-waiting-notice");
        expect(notice).toHaveTextContent("Waiting for Setup in main-4f3a2b1c");
        expect(interactionMode(SOURCE)).toBe("plan");
        expect(isEditable()).toBe(false);
        expect(screen.getByRole("button", { name: "Implement v2" })).toBeDisabled();

        act(() => {
          usePlanStore.setState({ plansByThread: { [SOURCE]: [makePlan(2, { id: READY_ID, status: "accepted" })] } });
          usePlanStore.getState().setPendingImplement(SOURCE, null);
        });
        await waitFor(() => expect(screen.queryByTestId("plan-waiting-notice")).toBeNull());
        expect(interactionMode(SOURCE)).toBe("build");
      });

      it("shows the held request after a reload, from the server's report alone", () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        usePlanStore.getState().setPendingImplement(SOURCE, { targetThreadId: TARGET, version: 2 });

        render(<PlanPanel threadId={SOURCE} />);

        expect(screen.getByTestId("plan-waiting-notice")).toHaveTextContent("Waiting for Setup in main-4f3a2b1c");
        expect(isEditable()).toBe(false);
      });

      it("ends the hold on the requested version even when a newer draft exists", () => {
        startInPlan(SOURCE, [makePlan(1, { id: "plan-1" }), makePlan(2, { id: READY_ID, status: "draft" })]);
        seedThreads();
        usePlanStore.getState().setPendingImplement(SOURCE, { targetThreadId: TARGET, version: 1 });
        render(<PlanPanel threadId={SOURCE} />);
        expect(screen.getByTestId("plan-waiting-notice")).toBeInTheDocument();

        act(() => {
          usePlanStore.setState({ plansByThread: { [SOURCE]: [makePlan(1, { id: "plan-1", status: "accepted" }), makePlan(2, { id: READY_ID, status: "superseded" })] } });
          usePlanStore.getState().setPendingImplement(SOURCE, null);
        });

        expect(screen.queryByTestId("plan-waiting-notice")).toBeNull();
        expect(interactionMode(SOURCE)).toBe("build");
      });

      it("switches the source to Build when a snapshot ends the hold before the clearing push arrives", () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        usePlanStore.getState().setPendingImplement(SOURCE, { targetThreadId: TARGET, version: 2 });
        const applySnapshot = usePlanStore.getState().beginPendingImplementRead(SOURCE);

        act(() => {
          usePlanStore.setState({ plansByThread: { [SOURCE]: [makePlan(2, { id: READY_ID, status: "accepted" })] } });
          applySnapshot(null);
          usePlanStore.getState().setPendingImplement(SOURCE, null);
        });

        expect(interactionMode(SOURCE)).toBe("build");
      });

      it("does not hold a later ready version after the request settled", () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        usePlanStore.getState().setPendingImplement(SOURCE, { targetThreadId: TARGET, version: 2 });
        render(<PlanPanel threadId={SOURCE} />);
        act(() => {
          usePlanStore.setState({ plansByThread: { [SOURCE]: [makePlan(2, { id: READY_ID, status: "accepted" })] } });
          usePlanStore.getState().setPendingImplement(SOURCE, null);
        });

        act(() => usePlanStore.getState().addPlan(SOURCE, makePlan(3, { id: "plan-3" })));

        expect(screen.queryByTestId("plan-waiting-notice")).toBeNull();
        expect(screen.getByRole("button", { name: "Implement v3" })).toBeEnabled();
      });

      it("returns the source to editing and stays in Plan when the server ends the hold without accepting", async () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        implementPlan.mockImplementation(async (request) => waitingReceipt(request));
        render(<PlanPanel threadId={SOURCE} />);
        await pressImplement("Implement v2");
        await screen.findByTestId("plan-waiting-notice");

        act(() => usePlanStore.getState().setPendingImplement(SOURCE, null));

        await waitFor(() => expect(screen.queryByTestId("plan-waiting-notice")).toBeNull());
        expect(isEditable()).toBe(true);
        expect(screen.getByRole("button", { name: "Implement v2" })).toBeEnabled();
        expect(interactionMode(SOURCE)).toBe("plan");
      });

      it("opens the waiting thread from the notice", async () => {
        startInPlan(SOURCE, [makePlan(2, { id: READY_ID })]);
        seedThreads();
        implementPlan.mockImplementation(async (request) => waitingReceipt(request));
        render(<PlanPanel threadId={SOURCE} />);
        await pressImplement("Implement v2");
        await screen.findByTestId("plan-waiting-notice");
        useWorkspaceStore.setState({ activeThreadId: SOURCE });

        await userEvent.setup().click(screen.getByRole("button", { name: "Open thread" }));

        expect(useWorkspaceStore.getState().activeThreadId).toBe(TARGET);
      });
    });

    it("implements a ready version at its revision and switches the thread to Build", async () => {
      const thread = "thread-implement-ready";
      startInPlan(thread, [makePlan(2, { id: READY_ID })]);
      implementPlan.mockImplementation(async (request) => receiptFor(request));
      render(<PlanPanel threadId={thread} />);

      await pressImplement("Implement v2");

      await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(1));
      expect(implementPlan.mock.calls[0][0]).toEqual({
        requestId: expect.any(String), threadId: thread, target: "thread", versionId: READY_ID, expectedRevision: 0,
      });
      await waitFor(() => expect(interactionMode(thread)).toBe("build"));
    });

    it("implements a draft at its current revision", async () => {
      const thread = "thread-implement-draft";
      usePlanStore.setState({ plansByThread: { [thread]: [makePlan(2, { id: READY_ID, status: "draft", revision: 4 })] } });
      implementPlan.mockImplementation(async (request) => receiptFor(request));
      render(<PlanPanel threadId={thread} />);

      await pressImplement("Implement v2");

      await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(1));
      expect(implementPlan.mock.calls[0][0]).toMatchObject({ versionId: READY_ID, expectedRevision: 4 });
    });

    it("carries unsent text and expects the revision its save will make", async () => {
      const thread = "thread-implement-pending";
      const ready = makePlan(2, { id: READY_ID });
      usePlanStore.setState({ plansByThread: { [thread]: [ready] } });
      implementPlan.mockImplementation(async (request) => receiptFor(request));
      render(<PlanPanel threadId={thread} />);

      typeAtEnd("Extra");
      await pressImplement("Implement v2");

      await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(1));
      const request = implementPlan.mock.calls[0][0];
      expect(request.expectedRevision).toBe(1);
      expect(request.pending).toMatchObject({ baseVersionId: READY_ID, baseRevision: 0, contentMd: `${ready.contentMd}Extra` });
      expect(request.versionId).toBe(request.pending?.versionId);
      expect(savePlanVersion).not.toHaveBeenCalled();
    });

    it("hides the split for a superseded version", async () => {
      usePlanStore.setState({
        plansByThread: { [THREAD]: [makePlan(1, { status: "superseded" }), makePlan(2)] },
        activeVersionByThread: { [THREAD]: 1 },
      });

      render(<PlanPanel threadId={THREAD} />);

      await waitFor(() => expect(editorText()).toContain("Step for v1"));
      expect(screen.queryByTestId("plan-implement")).toBeNull();
    });

    it("shows the newer version and says nothing was sent when the version changed", async () => {
      const thread = "thread-implement-conflict";
      usePlanStore.setState({ plansByThread: { [thread]: [makePlan(2, { id: READY_ID })] }, activeVersionByThread: { [thread]: 2 } });
      implementPlan.mockRejectedValue(new RpcError("Plan changed", "plan_conflict", { latestVersion: theirDraft() }));
      render(<PlanPanel threadId={thread} />);

      await pressImplement("Implement v2");

      expect(await screen.findByTestId("plan-implement-notice")).toHaveTextContent(PLAN_CHANGED_NOTICE);
      await waitFor(() => expect(editorText()).toContain("Their plan"));
      expect(screen.getByRole("button", { name: "Implement v3" })).toBeInTheDocument();
    });

    it("holds carried text in the conflict notice when the version changed", async () => {
      const thread = "thread-implement-carried-conflict";
      usePlanStore.setState({ plansByThread: { [thread]: [makePlan(2, { id: READY_ID })] } });
      implementPlan.mockRejectedValue(new RpcError("Plan changed", "plan_conflict", { latestVersion: theirDraft() }));
      render(<PlanPanel threadId={thread} />);

      typeAtEnd("Mine");
      await pressImplement("Implement v2");

      expect(await screen.findByTestId("plan-conflict-notice")).toBeInTheDocument();
      expect(screen.queryByTestId("plan-implement-notice")).toBeNull();
      expect(editorText()).toContain("Mine");
    });

    it("reports a refused request as interrupted and stays in Plan", async () => {
      const thread = "thread-implement-failed";
      startInPlan(thread, [makePlan(2)]);
      implementPlan.mockRejectedValue(new RpcError("Busy", "thread_busy"));
      render(<PlanPanel threadId={thread} />);

      await pressImplement("Implement v2");

      expect(await screen.findByTestId("plan-implement-notice")).toHaveTextContent(IMPLEMENT_FAILED_NOTICE);
      expect(interactionMode(thread)).toBe("plan");
    });

    it("resends the same request after each connection drop until one answers", async () => {
      const thread = "thread-implement-reconnect";
      startInPlan(thread, [makePlan(2, { id: READY_ID })]);
      const dropConnection = async () => {
        useConnectionStore.setState({ status: "reconnecting" });
        throw new Error("WebSocket disconnected");
      };
      implementPlan.mockImplementationOnce(dropConnection);
      implementPlan.mockImplementationOnce(dropConnection);
      implementPlan.mockImplementationOnce(async (request) => receiptFor(request));
      render(<PlanPanel threadId={thread} />);

      await pressImplement("Implement v2");
      await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(1));
      expect(interactionMode(thread)).toBe("plan");

      act(() => useConnectionStore.setState({ status: "connected" }));
      await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(2));
      act(() => useConnectionStore.setState({ status: "connected" }));

      await waitFor(() => expect(implementPlan).toHaveBeenCalledTimes(3));
      expect(implementPlan.mock.calls[2][0]).toEqual(implementPlan.mock.calls[0][0]);
      await waitFor(() => expect(interactionMode(thread)).toBe("build"));
      expect(screen.queryByTestId("plan-implement-notice")).toBeNull();
    });

    it("waits for the dropped socket's close event before resending", async () => {
      const thread = "thread-implement-closing";
      startInPlan(thread, [makePlan(2, { id: READY_ID })]);
      // Drops until the close event has run, capped so a resend that never
      // yields to it fails the count below instead of starving the worker.
      let closeEventRan = false;
      let attempts = 0;
      implementPlan.mockImplementation(async (request) => {
        attempts += 1;
        if (closeEventRan || attempts > 20) return receiptFor(request);
        setTimeout(() => {
          closeEventRan = true;
          useConnectionStore.setState({ status: "reconnecting" });
        }, 0);
        throw new Error("WebSocket disconnected");
      });
      render(<PlanPanel threadId={thread} />);

      await pressImplement("Implement v2");
      await waitFor(() => expect(useConnectionStore.getState().status).toBe("reconnecting"));
      act(() => useConnectionStore.setState({ status: "connected" }));

      await waitFor(() => expect(interactionMode(thread)).toBe("build"));
      expect(implementPlan).toHaveBeenCalledTimes(2);
    });

    it("reports a closed transport as interrupted without resending", async () => {
      const thread = "thread-implement-closed";
      startInPlan(thread, [makePlan(2, { id: READY_ID })]);
      implementPlan.mockRejectedValueOnce(new Error("Transport closed"));
      render(<PlanPanel threadId={thread} />);

      await pressImplement("Implement v2");

      expect(await screen.findByTestId("plan-implement-notice")).toHaveTextContent(IMPLEMENT_FAILED_NOTICE);
      expect(implementPlan).toHaveBeenCalledTimes(1);
    });
  });
});

describe("planEditorAccess", () => {
  const latest = makePlan(2);
  const target = { versionId: latest.id, baseVersionId: "plan-1", baseRevision: 0 };

  it("allows comments again once an autosave is acknowledged, but not while text is unsaved", () => {
    const settled = { kind: "editing", target, text: "saved", ackedText: "saved", inFlight: null } as const;
    const typing = { ...settled, text: "saved plus more" };

    expect(planEditorAccess(latest, latest, settled, false).canComment).toBe(true);
    expect(planEditorAccess(latest, latest, typing, false).canComment).toBe(false);
  });

  it("takes comments on a superseded version, but not on an accepted one or during a run", () => {
    const settled = { kind: "idle" } as const;
    const superseded = makePlan(1, { status: "superseded" });
    const accepted = makePlan(2, { status: "accepted" });

    expect(planEditorAccess(superseded, latest, settled, false).canComment).toBe(true);
    expect(planEditorAccess(accepted, accepted, settled, false).canComment).toBe(false);
    expect(planEditorAccess(latest, latest, settled, true).canComment).toBe(false);
  });
});
