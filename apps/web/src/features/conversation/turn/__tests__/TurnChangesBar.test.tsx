import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffStats, FileEffect, TurnSnapshot } from "@mcode/contracts";
import { createMockThread } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { TurnChangesBar } from "../TurnChangesBar";

const transport = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  getSnapshotDiffStats: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

vi.mock("@/stores/thread-selectors", () => ({
  readThreadRecord: () => ({ serverMessageIds: {} }),
}));

const showRightPanelAdaptive = vi.hoisted(() => vi.fn());
vi.mock("@/lib/right-panel-layout", () => ({
  showRightPanelAdaptive,
}));

function effect(path: string, overrides: Partial<FileEffect> = {}): FileEffect {
  return {
    path,
    kind: "edited",
    scope: "workspace",
    additions: 1,
    deletions: 1,
    binary: false,
    toolCallIds: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    id: "snap-1",
    message_id: "msg-1",
    thread_id: "thread-1",
    ref_before: "before",
    ref_after: "after",
    files_changed: [],
    worktree_path: null,
    created_at: "2026-10-01T10:00:00.000Z",
    attempt_count: 1,
    ...overrides,
  };
}

function withEffects(effects: FileEffect[], overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return snapshot({
    files_changed: effects.map((e) => e.path),
    file_effects: { revision: 1, fileCount: effects.length, additions: 0, deletions: 0, effects },
    ...overrides,
  });
}

function stat(filePath: string, additions: number, deletions: number, changeType: DiffStats["changeType"] = "modified"): DiffStats {
  return { filePath, additions, deletions, changeType };
}

function seedSnapshots(snapshots: TurnSnapshot[]) {
  useDiffStore.setState({ snapshotsByThread: { "thread-1": snapshots } });
}

function renderBar(overrides: { isLatestTurn?: boolean; filesChanged?: string[]; threadId?: string } = {}) {
  return render(
    <TurnChangesBar
      threadId={overrides.threadId ?? "thread-1"}
      messageId="msg-1"
      filesChanged={overrides.filesChanged ?? []}
      isLatestTurn={overrides.isLatestTurn ?? true}
    />,
  );
}

function row(name: string): HTMLElement {
  const button = screen.getByRole("button", { name: `Review ${name}` });
  const container = button.parentElement;
  if (!container) throw new Error(`no row for ${name}`);
  return container;
}

function header(): HTMLElement {
  return screen.getByRole("button", { expanded: true, name: /^Changed/ });
}

describe("TurnChangesBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.listSnapshots.mockResolvedValue([]);
    transport.getSnapshotDiffStats.mockResolvedValue([]);
    useWorkspaceStore.setState({
      activeThreadId: "thread-1",
      activeWorkspaceId: "workspace-1",
      threads: [
        createMockThread({ id: "thread-1", workspace_id: "workspace-1" }),
        createMockThread({ id: "thread-other", workspace_id: "workspace-2" }),
      ],
    });
    useDiffStore.setState({
      snapshotsByThread: {},
      reviewFileJumpRequest: null,
      selectedTurnByThread: {},
      reviewViewByThread: {},
      reviewViewManuallySelectedByThread: {},
      viewMode: "turn",
    });
  });

  it("lists recorded effects by folder with kinds, counts, and later edits", () => {
    seedSnapshots([
      withEffects([
        effect("apps/web/src/chat/Bar.tsx", { additions: 12, deletions: 3 }),
        effect("apps/web/src/chat/new-file.ts", { kind: "added", additions: 31, deletions: 0 }),
        effect("apps/web/src/old.ts", { kind: "removed", additions: 0, deletions: 40 }),
        effect("apps/web/src/chat/Renamed.tsx", { kind: "renamed", oldPath: "apps/web/src/chat/Original.tsx", additions: 2, deletions: 2 }),
        effect("/tmp/outside.txt", { scope: "external" }),
      ]),
      snapshot({ id: "snap-2", message_id: "msg-2", created_at: "2026-10-01T11:00:00.000Z", files_changed: ["apps/web/src/chat/Bar.tsx"] }),
    ]);

    renderBar();

    expect(header()).toHaveTextContent("Changed 4 files+45−45");
    expect(transport.getSnapshotDiffStats).not.toHaveBeenCalled();
    expect(screen.queryByText("outside.txt")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^chat3/, expanded: true })).toHaveTextContent("chat3+45−5");
    expect(row("apps/web/src/chat/Bar.tsx")).toHaveTextContent("Bar.tsxedited later+12−3");
    expect(row("apps/web/src/chat/new-file.ts")).toHaveTextContent("new-file.tsnew+31");
    expect(row("apps/web/src/chat/Renamed.tsx")).toHaveTextContent("Renamed.tsxfrom Original.tsx+2−2");
    expect(row("apps/web/src/old.ts")).toHaveTextContent("old.tsdeleted−40");
    expect(within(row("apps/web/src/old.ts")).getByText("old.ts")).toHaveClass("line-through");
  });

  it("shows Binary in the count lane and blank lanes for uncounted files", () => {
    seedSnapshots([
      withEffects([
        effect("assets/menu-preview.png", { kind: "added", binary: true, additions: null, deletions: null }),
        effect("assets/notes.md", { additions: null, deletions: null }),
      ]),
    ]);

    renderBar();

    expect(row("assets/menu-preview.png")).toHaveTextContent(/^menu-preview\.pngnewBinary$/);
    expect(row("assets/notes.md")).toHaveTextContent(/^notes\.md$/);
  });

  it("starts an older turn collapsed to one summary row", () => {
    seedSnapshots([withEffects([effect("src/a.ts", { additions: 5, deletions: 0 })])]);

    renderBar({ isLatestTurn: false });

    expect(screen.getByRole("button", { expanded: false, name: /^Changed/ })).toHaveTextContent("Changed 1 file+5");
    expect(screen.queryByRole("button", { name: "Review src/a.ts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /all folders/ })).not.toBeInTheDocument();
  });

  it("opens a long turn with top-level folders collapsed and a Review all footer", async () => {
    const paths = [
      ...Array.from({ length: 5 }, (_, i) => `server/agents/a${i}.ts`),
      ...Array.from({ length: 5 }, (_, i) => `web/chat/c${i}.ts`),
      ...Array.from({ length: 4 }, (_, i) => `docs/d${i}.md`),
    ];
    seedSnapshots([withEffects(paths.map((path) => effect(path)))]);
    const user = userEvent.setup();

    renderBar();

    expect(screen.getByText("3 folders ·")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review web/chat/c0.ts" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand all folders" }));
    expect(screen.getByRole("button", { name: "Review web/chat/c0.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse all folders" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Review all" }));
    expect(useDiffStore.getState().selectedTurnByThread["thread-1"]).toBe("msg-1");
  });

  it("hides the collapse-all control when the list has no folders", () => {
    seedSnapshots([withEffects([effect("src/a.ts"), effect("src/b.ts")])]);

    renderBar();

    expect(screen.queryByRole("button", { name: /all folders/ })).not.toBeInTheDocument();
  });

  it("shows names with loading counts until legacy stats arrive", async () => {
    let resolveStats: (stats: DiffStats[]) => void = () => {};
    transport.getSnapshotDiffStats.mockReturnValue(new Promise<DiffStats[]>((resolve) => { resolveStats = resolve; }));
    seedSnapshots([snapshot({ files_changed: ["src/a.ts", "src/b.ts"] })]);

    renderBar();

    expect(screen.getByLabelText("Loading counts")).toBeInTheDocument();
    expect(row("src/a.ts")).toHaveTextContent(/^a\.ts$/);
    resolveStats([stat("src/a.ts", 3, 1), stat("src/b.ts", 0, 2)]);
    await waitFor(() => expect(header()).toHaveTextContent("Changed 2 files+3−3"));
    expect(row("src/a.ts")).toHaveTextContent("a.ts+3−1");
    expect(row("src/b.ts")).toHaveTextContent(/^b\.ts−2$/);
  });

  it("counts a turn with an empty recorded summary over its git range", async () => {
    transport.getSnapshotDiffStats.mockResolvedValue([stat("src/a.ts", 4, 0, "added")]);
    seedSnapshots([snapshot({
      files_changed: ["src/a.ts"],
      file_effects: { revision: 0, fileCount: 0, additions: 0, deletions: 0, effects: [] },
    })]);

    renderBar();

    await waitFor(() => expect(header()).toHaveTextContent("Changed 1 file+4"));
    expect(transport.getSnapshotDiffStats).toHaveBeenCalledWith("snap-1");
  });

  it("says Counts unavailable when the stats request fails", async () => {
    transport.getSnapshotDiffStats.mockRejectedValue(new Error("git exploded"));
    seedSnapshots([snapshot({ files_changed: ["src/a.ts", "src/b.ts"] })]);

    renderBar();

    expect(await screen.findByText("Counts unavailable")).toBeInTheDocument();
    expect(row("src/a.ts")).toHaveTextContent(/^a\.ts$/);
  });

  it("says Counts unavailable when the stats come back as a comparison error", async () => {
    transport.getSnapshotDiffStats.mockResolvedValue({ status: "unavailable", reason: "snapshot-pruned" });
    seedSnapshots([snapshot({ files_changed: ["src/a.ts"] })]);

    renderBar();

    expect(await screen.findByText("Counts unavailable")).toBeInTheDocument();
  });

  it("counts a retried turn over its git range instead of its last attempt's effects", async () => {
    let resolveStats: (stats: DiffStats[]) => void = () => {};
    transport.getSnapshotDiffStats.mockReturnValue(new Promise<DiffStats[]>((resolve) => { resolveStats = resolve; }));
    seedSnapshots([
      withEffects(
        [effect("src/b.ts", { additions: 900, deletions: 900 }), effect("src/c.ts", { additions: 800, deletions: 800 })],
        { attempt_count: 2, files_changed: ["src/a.ts", "src/b.ts", "src/c.ts"] },
      ),
    ]);

    renderBar();

    expect(screen.getByLabelText("Loading counts")).toBeInTheDocument();
    expect(screen.queryByText("+900")).not.toBeInTheDocument();
    expect(transport.getSnapshotDiffStats).toHaveBeenCalledWith("snap-1");

    resolveStats([stat("src/a.ts", 4, 0, "added"), stat("src/b.ts", 2, 1), stat("src/c.ts", 0, 6, "deleted")]);

    expect(await screen.findByText("Changed 3 files")).toBeInTheDocument();
    expect(header()).toHaveTextContent("Changed 3 files+6−7");
    expect(row("src/a.ts")).toHaveTextContent("a.tsnew+4");
    expect(row("src/b.ts")).toHaveTextContent("b.ts+2−1");
    expect(row("src/c.ts")).toHaveTextContent("c.tsdeleted−6");
    expect(screen.queryByText("+900")).not.toBeInTheDocument();
    expect(screen.queryByText("+800")).not.toBeInTheDocument();
  });

  it("copies every changed path, including rows hidden by the initial collapse", async () => {
    const paths = [
      ...Array.from({ length: 7 }, (_, i) => `server\\agents\\a${i}.ts`),
      ...Array.from({ length: 7 }, (_, i) => `web/chat/c${i}.ts`),
    ];
    seedSnapshots([withEffects(paths.map((path) => effect(path)))]);
    const user = userEvent.setup();

    renderBar();
    await user.click(screen.getByRole("button", { name: "Turn actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy file paths" }));

    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(paths.map((p) => p.replace(/\\/g, "/")).join("\n"));
    });
  });

  it("loads snapshots for its own thread, not the active one", async () => {
    useWorkspaceStore.setState({ activeThreadId: "thread-other", activeWorkspaceId: "workspace-2" });
    transport.listSnapshots.mockResolvedValue([withEffects([effect("src/mine.ts", { additions: 7, deletions: 0 })])]);

    renderBar({ filesChanged: ["src/mine.ts"] });

    await waitFor(() => expect(header()).toHaveTextContent("Changed 1 file+7"));
    expect(transport.listSnapshots).toHaveBeenCalledTimes(1);
    expect(transport.listSnapshots).toHaveBeenCalledWith("thread-1");
  });

  it("names the transcript's files as unavailable when the turn has no snapshot", async () => {
    seedSnapshots([]);

    renderBar({ filesChanged: ["src\\gone.ts"] });

    expect(await screen.findByText("Counts unavailable")).toBeInTheDocument();
    expect(row("src/gone.ts")).toHaveTextContent(/^gone\.ts$/);
  });

  it("pins its own turn when opening Review from the latest turn's header", async () => {
    useWorkspaceStore.setState({ activeThreadId: "thread-other", activeWorkspaceId: "workspace-2" });
    seedSnapshots([withEffects([effect("src/a.ts")])]);
    const user = userEvent.setup();

    renderBar();
    await user.click(screen.getByRole("button", { name: "Review" }));

    expect(showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
    expect(useDiffStore.getState().reviewViewByThread["thread-1"]).toBe("turn");
    expect(useDiffStore.getState().selectedTurnByThread["thread-1"]).toBe("msg-1");
  });

  it("pins an older turn when opening Review from its menu", async () => {
    seedSnapshots([withEffects([effect("src/a.ts")])]);
    const user = userEvent.setup();

    renderBar({ isLatestTurn: false });
    await user.click(screen.getByRole("button", { name: "Turn actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Review changes" }));

    expect(showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
    expect(useDiffStore.getState().reviewViewByThread["thread-1"]).toBe("turn");
    expect(useDiffStore.getState().selectedTurnByThread["thread-1"]).toBe("msg-1");
  });

  it("opens Review on an older turn and jumps to a clicked file", async () => {
    seedSnapshots([withEffects([effect("src/a.ts"), effect("src/b.ts")])]);
    const user = userEvent.setup();

    renderBar({ isLatestTurn: false });
    await user.click(screen.getByRole("button", { expanded: false, name: /^Changed/ }));
    await user.click(screen.getByRole("button", { name: "Review src/b.ts" }));

    expect(useDiffStore.getState().selectedTurnByThread["thread-1"]).toBe("msg-1");
    expect(useDiffStore.getState().reviewFileJumpRequest).toMatchObject({
      scopeId: "thread-1",
      path: "src/b.ts",
      viewKey: "turn:msg-1",
    });
  });
});
