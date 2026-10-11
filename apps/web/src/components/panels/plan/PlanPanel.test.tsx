import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSaveVersion, PlanVersion } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { useThreadStore } from "@/stores/threadStore";
import { RpcError } from "@/transport/ws-transport";
import { PlanPanel } from "./PlanPanel";
import { planSaveScheduler } from "./plan-draft-sessions";

const savePlanVersion = vi.hoisted(() => vi.fn<(payload: PlanSaveVersion) => Promise<PlanVersion>>());
vi.mock("@/transport", () => ({ getTransport: () => ({ savePlanVersion }) }));

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
});
