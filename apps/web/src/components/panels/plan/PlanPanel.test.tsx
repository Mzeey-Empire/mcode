import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanImplement, PlanImplementReceipt, PlanSaveVersion, PlanVersion } from "@mcode/contracts";
import { useConnectionStore } from "@/stores/connectionStore";
import { usePlanStore } from "@/stores/planStore";
import { useThreadStore } from "@/stores/threadStore";
import { RpcError } from "@/transport/ws-transport";
import { PlanPanel } from "./PlanPanel";
import { planSaveScheduler } from "./plan-draft-sessions";
import { IMPLEMENT_FAILED_NOTICE, PLAN_CHANGED_NOTICE } from "./plan-implement";

const savePlanVersion = vi.hoisted(() => vi.fn<(payload: PlanSaveVersion) => Promise<PlanVersion>>());
const implementPlan = vi.hoisted(() => vi.fn<(payload: PlanImplement) => Promise<PlanImplementReceipt>>());
vi.mock("@/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transport")>()),
  getTransport: () => ({ savePlanVersion, implementPlan, updateThreadSettings: vi.fn(async () => true) }),
}));

const THREAD = "thread-plan";

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
    usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {} });
    useThreadStore.setState({ runningThreadIds: new Set() });
    savePlanVersion.mockReset();
    implementPlan.mockReset();
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
