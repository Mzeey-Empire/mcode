import { createMockMessage } from "@mcode/contracts/testing";
import { createAgentModelState, type AgentModelState } from "@mcode/contracts/compat/agent-model";
import { ORPHANED_BACKGROUND_TOOL_OUTPUT, PLANNED_RESTART_NOTICE_KEY_PREFIX, plannedRestartNoticeText } from "@mcode/shared/planned-restart";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageBubble } from "../../messages/MessageBubble";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import type { Message } from "@/transport";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { mockTransport } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transport")>()),
  getTransport: () => mockTransport,
}));

const THREAD = "thread-restart";
const ANCHOR = "turn-anchor";
const OTHER = "turn-other";
const AT = "2026-11-18T10:00:00.000Z";
/** When this start's settlement stopped held calls, after the anchor turn ended at `AT`. */
const SETTLED = "2026-11-18T10:05:00.000Z";

interface CallSeed {
  id: string; turnId: string; kind: "subagent" | "command"; label: string; output: string; status?: string; background?: boolean;
  settledAt?: string;
}

/** Each turn ends when it is created, so a turn's creation time is also its end time. */
function addTurn(state: AgentModelState, id: string, createdAt = AT): void {
  state.turns[id] = {
    id, threadId: THREAD, status: "Completed", trigger: { kind: "user" }, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null, providerIdentities: [],
    startedAt: createdAt, providerStartedAt: createdAt, endedAt: createdAt, ending: null, createdAt, updatedAt: createdAt,
  };
}

function addCall(state: AgentModelState, call: CallSeed): void {
  state.items[call.id] = {
    id: call.id, threadId: THREAD, turnId: call.turnId, kind: "tool-call", providerIdentities: [], createdAt: AT, updatedAt: AT,
    payload: { projection: "toolCall", record: {
      id: call.id, message_id: "answer", parent_tool_call_id: null, tool_name: call.kind === "subagent" ? "Agent" : "Bash",
      input_summary: call.label, output_summary: call.output, status: call.status ?? "cancelled", background: call.background ?? true,
      background_kind: call.kind, background_label: call.label, started_at: AT, completed_at: call.settledAt ?? SETTLED, sort_order: 0,
    } },
  };
}

function objectRecord(payload: Record<string, unknown>): Record<string, unknown> {
  const record = payload.record;
  return record && typeof record === "object" ? { ...record } : {};
}

function seed(calls: readonly CallSeed[], turns: Readonly<Record<string, string>> = { [ANCHOR]: AT, [OTHER]: AT }, messages: Message[] = []): AgentModelState {
  const state = createAgentModelState();
  for (const [id, createdAt] of Object.entries(turns)) addTurn(state, id, createdAt);
  for (const call of calls) addCall(state, call);
  const record = createEmptyThreadRecord();
  resetThreadStoreForTests({ records: new Map([[THREAD, { ...record, messages, canonicalAgent: { ...record.canonicalAgent, state } }]]) });
  return state;
}

function notice(content: string, noticeKey: string, id = "notice"): Message {
  return createMockMessage({ id, thread_id: THREAD, role: "system", content, timestamp: AT,
    systemNotice: { kind: "diagnostic", presentation: "timeline", noticeKey } });
}

afterEach(() => {
  cleanup();
  resetThreadStoreForTests();
});

describe("planned restart notices", () => {
  it("lists only the anchor turn's background calls the restart stopped", async () => {
    seed([
      { id: "agent", turnId: ANCHOR, kind: "subagent", label: "Audit contrast", output: ORPHANED_BACKGROUND_TOOL_OUTPUT },
      { id: "watch", turnId: ANCHOR, kind: "command", label: "bun run test --watch", output: ORPHANED_BACKGROUND_TOOL_OUTPUT },
      { id: "elsewhere", turnId: OTHER, kind: "command", label: "other turn", output: ORPHANED_BACKGROUND_TOOL_OUTPUT },
      { id: "user-stop", turnId: ANCHOR, kind: "command", label: "stopped by user", output: "Stopped by the user." },
      { id: "foreground", turnId: ANCHOR, kind: "command", label: "foreground", output: ORPHANED_BACKGROUND_TOOL_OUTPUT, background: false },
    ]);
    render(<MessageBubble message={notice(plannedRestartNoticeText("wake", "started"), `${PLANNED_RESTART_NOTICE_KEY_PREFIX}${ANCHOR}`)} />);

    const toggle = screen.getByRole("button", { name: /Woke after Mcode restarted/ });
    expect(toggle).toHaveTextContent("2 background tasks stopped");
    await userEvent.click(toggle);
    const list = screen.getByRole("list", { name: "Background tasks stopped by the restart" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "SubagentAudit contrastStopped",
      "Commandbun run test --watchStopped",
    ]);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("marks a failed wake as an error note, never an alert, while still listing its stopped calls", () => {
    seed([{ id: "agent", turnId: ANCHOR, kind: "subagent", label: "Audit contrast", output: ORPHANED_BACKGROUND_TOOL_OUTPUT }]);
    render(<MessageBubble message={notice(plannedRestartNoticeText("wake", "failed"), `${PLANNED_RESTART_NOTICE_KEY_PREFIX}${ANCHOR}`)} />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("Error: Could not wake after Mcode restarted");
    expect(screen.getByRole("button", { name: /Could not wake/ })).toHaveTextContent("1 background task stopped");
  });

  it("shows a failed resume as an error hairline and a successful one as a plain note", () => {
    seed([]);
    const key = `${PLANNED_RESTART_NOTICE_KEY_PREFIX}execution-1`;
    const { rerender } = render(<MessageBubble message={notice(plannedRestartNoticeText("resume", "failed"), key)} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("Error: Could not resume after Mcode restarted");

    rerender(<MessageBubble message={{ ...notice(plannedRestartNoticeText("resume", "started"), key), id: "notice-2" }} />);
    expect(screen.getByRole("note")).toHaveTextContent(/^Resumed after Mcode restarted$/);
  });

  it("keeps other diagnostic notices in the neutral tone even with failure wording", () => {
    seed([]);
    render(<MessageBubble message={notice(plannedRestartNoticeText("wake", "failed"), "other-feature:1")} />);
    expect(screen.getByRole("note")).toHaveTextContent(/^Could not wake after Mcode restarted$/);
  });

  async function listedFor(anchor: string): Promise<string[]> {
    const view = render(<MessageBubble message={notice(plannedRestartNoticeText("wake", "started"), `${PLANNED_RESTART_NOTICE_KEY_PREFIX}${anchor}`)} />);
    await userEvent.click(screen.getByRole("button", { name: /Woke after Mcode restarted/ }));
    const list = screen.getByRole("list", { name: "Background tasks stopped by the restart" });
    const labels = within(list).getAllByRole("listitem").map((item) => item.textContent ?? "");
    view.unmount();
    return labels;
  }

  const stopped = { kind: "command", output: ORPHANED_BACKGROUND_TOOL_OUTPUT } as const;

  it("lists a call from an older turn that was still running at this restart", async () => {
    seed([{ ...stopped, id: "older", turnId: "turn-older", label: "bun run dev" }],
      { "turn-older": "2026-11-18T09:30:00.000Z", [ANCHOR]: AT });
    expect(await listedFor(ANCHOR)).toEqual(["Commandbun run devStopped"]);
  });

  it("does not list a call an earlier crash stopped before the anchor turn ended", async () => {
    seed([
      { ...stopped, id: "crashed", turnId: "turn-older", label: "stopped by the crash", settledAt: "2026-11-18T09:40:00.000Z" },
      { ...stopped, id: "held", turnId: ANCHOR, label: "bun run dev" },
    ], { "turn-older": "2026-11-18T09:30:00.000Z", [ANCHOR]: AT });
    expect(await listedFor(ANCHOR)).toEqual(["Commandbun run devStopped"]);
  });

  it("lists exactly its own calls for each of two planned restarts in one thread", async () => {
    const earlierWake = "turn-earlier-wake";
    seed([
      { ...stopped, id: "first", turnId: earlierWake, label: "first restart", settledAt: "2026-11-18T09:15:00.000Z" },
      { ...stopped, id: "second", turnId: ANCHOR, label: "second restart" },
    ], { [earlierWake]: "2026-11-18T09:10:00.000Z", [ANCHOR]: AT });
    expect(await listedFor(earlierWake)).toEqual(["Commandfirst restartStopped"]);
    expect(await listedFor(ANCHOR)).toEqual(["Commandsecond restartStopped"]);
  });

  it("states the true total and how many rows the list leaves out", async () => {
    seed(Array.from({ length: 23 }, (_, index) => ({ id: `call-${String(index).padStart(2, "0")}`, turnId: ANCHOR, kind: "command" as const,
      label: `task ${index}`, output: ORPHANED_BACKGROUND_TOOL_OUTPUT })));
    render(<MessageBubble message={notice(plannedRestartNoticeText("wake", "started"), `${PLANNED_RESTART_NOTICE_KEY_PREFIX}${ANCHOR}`)} />);

    const toggle = screen.getByRole("button", { name: /Woke after Mcode restarted/ });
    expect(toggle).toHaveTextContent("23 background tasks stopped");
    await userEvent.click(toggle);
    const rows = within(screen.getByRole("list", { name: "Background tasks stopped by the restart" })).getAllByRole("listitem");
    expect(rows).toHaveLength(21);
    expect(rows.at(-1)).toHaveTextContent("and 3 more");
  });

  it("neither re-renders nor re-reads its calls while unrelated later-turn items stream", () => {
    const state = seed([{ id: "agent", turnId: ANCHOR, kind: "subagent", label: "Audit contrast", output: ORPHANED_BACKGROUND_TOOL_OUTPUT }],
      { [ANCHOR]: AT, [OTHER]: "2026-11-18T11:00:00.000Z" });
    const anchorItem = state.items.agent!;
    const { payload, kind, turnId, ...fields } = anchorItem;
    let payloadReads = 0;
    let visits = 0;
    Object.defineProperty(anchorItem, "payload", { get: () => { payloadReads += 1; return payload; } });
    Object.defineProperty(anchorItem, "kind", { get: () => { visits += 1; return kind; } });
    Object.defineProperty(anchorItem, "turnId", { get: () => { visits += 1; return turnId; } });
    let renders = 0;
    render(
      <Profiler id="notice" onRender={() => { renders += 1; }}>
        <MessageBubble message={notice(plannedRestartNoticeText("wake", "started"), `${PLANNED_RESTART_NOTICE_KEY_PREFIX}${ANCHOR}`)} />
      </Profiler>,
    );
    const rendersAfterMount = renders;
    const readsAfterMount = payloadReads;
    const visitsAfterMount = visits;
    const load = (id: string, turn: string) => act(() => useThreadStore.setState((store) => {
      const record = store.records.get(THREAD)!;
      const current = record.canonicalAgent.state;
      const item = { ...fields, payload: { ...payload, record: { ...objectRecord(payload), id } }, kind, id, turnId: turn };
      const streamed = { ...current, items: { ...current.items, [item.id]: item } };
      return { records: new Map(store.records).set(THREAD, { ...record, canonicalAgent: { ...record.canonicalAgent, state: streamed } }) };
    }));

    for (let index = 0; index < 5; index++) load(`stream-${index}`, OTHER);
    expect(screen.getByRole("button", { name: /Woke after Mcode restarted/ })).toHaveTextContent("1 background task stopped");
    expect(renders).toBe(rendersAfterMount);
    expect(payloadReads).toBe(readsAfterMount);
    expect(visits).toBe(visitsAfterMount);

    load("late-anchor-call", ANCHOR);
    expect(screen.getByRole("button", { name: /Woke after Mcode restarted/ })).toHaveTextContent("2 background tasks stopped");
    expect(visits).toBe(visitsAfterMount);
  });
});
