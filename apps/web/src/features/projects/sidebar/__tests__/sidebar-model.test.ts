import { describe, expect, it } from "vitest";
import {
  PROJECT_ROW_CAP,
  deriveSidebarModel,
  reconcileItems,
  trackNeedsUserEnds,
  type PendingCompletion,
  type SidebarInputs,
  type SidebarItem,
  type SidebarThreadFacts,
} from "../sidebar-model";
import { classifyCause } from "../use-sidebar-model";

const DAY = 86_400_000;
const NOW = 100 * DAY;

function fact(id: string, overrides: Partial<SidebarThreadFacts> = {}): SidebarThreadFacts {
  return { id, workspaceId: "ws-a", parentId: null, activityMs: NOW - DAY, completedMs: null, ...overrides };
}

function inputs(overrides: Partial<Omit<SidebarInputs, "ui">> & { ui?: Partial<SidebarInputs["ui"]> } = {}): SidebarInputs {
  const { ui, ...rest } = overrides;
  return {
    facts: [],
    projectOrder: ["ws-a", "ws-b"],
    draftsByWorkspace: new Map(),
    needsUserIds: new Set(),
    needsUserEndedAt: new Map(),
    completions: new Map(),
    olderAfterDays: 14,
    selectedThreadId: null,
    now: NOW,
    snapshotEpoch: 0,
    ...rest,
    ui: {
      scope: "active",
      view: "projects",
      olderOpen: false,
      collapsedProjects: new Set(),
      collapsedOlderProjects: new Set(),
      showMore: new Set(),
      frozen: null,
      ...ui,
    },
  };
}

function keys(items: readonly SidebarItem[]): string[] {
  return items.map((item) => item.key);
}

function threadKeys(items: readonly SidebarItem[]): string[] {
  return items.flatMap((item) => (item.kind === "thread" ? [item.threadId] : []));
}

function threadItem(items: readonly SidebarItem[], id: string): Extract<SidebarItem, { kind: "thread" }> | undefined {
  return items.find((item): item is Extract<SidebarItem, { kind: "thread" }> => item.kind === "thread" && item.threadId === id);
}

describe("deriveSidebarModel", () => {
  it("sorts by activity, newest first, and frozen keys win over live ones", () => {
    const facts = [fact("old", { activityMs: NOW - 3 * DAY }), fact("new", { activityMs: NOW - DAY }), fact("mid", { activityMs: NOW - 2 * DAY })];
    expect(threadKeys(deriveSidebarModel(inputs({ facts })).items)).toEqual(["new", "mid", "old"]);

    const frozen = { at: NOW, activityMs: new Map([["old", NOW - 10], ["new", NOW - DAY], ["mid", NOW - 2 * DAY]]) };
    const live = [...facts.slice(1), fact("old", { activityMs: NOW - 3 * DAY })];
    expect(threadKeys(deriveSidebarModel(inputs({ facts: live, ui: { frozen } })).items)).toEqual(["old", "new", "mid"]);
  });

  it("nests families under their parent and sorts each family by its newest member", () => {
    const facts = [
      fact("solo", { activityMs: NOW - 2 * DAY }),
      fact("parent", { activityMs: NOW - 5 * DAY }),
      fact("child", { parentId: "parent", activityMs: NOW - DAY / 2 }),
    ];
    const items = deriveSidebarModel(inputs({ facts })).items;

    expect(threadKeys(items)).toEqual(["parent", "child", "solo"]);
    expect(threadItem(items, "child")?.depth).toBe(1);
  });

  it("never splits a family at the cap and shows Show more for the rest", () => {
    const roots = Array.from({ length: PROJECT_ROW_CAP - 1 }, (_, index) => fact(`r${index}`, { activityMs: NOW - (index + 1) * 1000 }));
    const family = [fact("fam", { activityMs: NOW - 10_000 }), fact("fam-child", { parentId: "fam", activityMs: NOW - 20_000 })];
    const tail = fact("tail", { activityMs: NOW - 30_000 });
    const items = deriveSidebarModel(inputs({ facts: [...roots, ...family, tail] })).items;

    expect(threadKeys(items)).toEqual([...roots.map((entry) => entry.id), "fam", "fam-child"]);
    expect(items.find((item) => item.kind === "show-more")).toMatchObject({ hidden: 1, expanded: false });
  });

  it("appends a selected thread that falls past the cap", () => {
    const facts = Array.from({ length: PROJECT_ROW_CAP + 2 }, (_, index) => fact(`t${index}`, { activityMs: NOW - (index + 1) * 1000 }));
    const last = facts.at(-1)!.id;
    const items = deriveSidebarModel(inputs({ facts, selectedThreadId: last })).items;

    expect(threadKeys(items)).toEqual([...facts.slice(0, PROJECT_ROW_CAP).map((entry) => entry.id), last]);
    expect(items.find((item) => item.kind === "show-more")).toMatchObject({ hidden: 1 });
  });

  it("makes a child whose parent is Older a root of the recent list", () => {
    const facts = [fact("parent", { activityMs: NOW - 20 * DAY }), fact("child", { parentId: "parent", activityMs: NOW - DAY })];
    const model = deriveSidebarModel(inputs({ facts }));

    expect(threadItem(model.items, "child")).toMatchObject({ section: "recent", depth: 0 });
    expect(model.olderIds).toEqual(new Set(["parent"]));
  });

  it("omits a project above the bar when all its threads are Older", () => {
    const facts = [fact("a-recent"), fact("b-old", { workspaceId: "ws-b", activityMs: NOW - 20 * DAY })];
    const items = deriveSidebarModel(inputs({ facts, ui: { olderOpen: true } })).items;

    expect(keys(items)).toEqual([
      "project:ws-a",
      "thread:a-recent",
      "older-bar",
      "older-project:ws-b",
      "thread:b-old",
      "end-spacer",
    ]);
  });

  it("keeps needs-user and pending threads out of Older", () => {
    const stale = NOW - 30 * DAY;
    const facts = [fact("needs", { activityMs: stale }), fact("pending", { activityMs: stale }), fact("quiet", { activityMs: stale })];
    const completions = new Map<string, PendingCompletion>([["pending", { phase: "holding" }]]);
    const model = deriveSidebarModel(inputs({ facts, needsUserIds: new Set(["needs"]), completions }));

    expect(model.olderIds).toEqual(new Set(["quiet"]));
  });

  it("starts the Older clock when a thread stopped needing the user this session", () => {
    const facts = [fact("opened", { activityMs: NOW - 30 * DAY })];
    const model = deriveSidebarModel(inputs({ facts, needsUserEndedAt: new Map([["opened", NOW - DAY]]) }));

    expect(model.olderIds.size).toBe(0);
    expect(threadItem(model.items, "opened")?.section).toBe("recent");
    expect(model.nextBoundaryAt).toBe(NOW - DAY + 14 * DAY);
  });

  it("shows only the selected thread under a closed Older bar", () => {
    const facts = [fact("old-1", { activityMs: NOW - 20 * DAY }), fact("old-2", { activityMs: NOW - 21 * DAY })];
    const items = deriveSidebarModel(inputs({ facts, selectedThreadId: "old-2" })).items;

    expect(keys(items).slice(-3)).toEqual(["older-bar", "thread:old-2", "end-spacer"]);
    expect(items.find((item) => item.kind === "older-bar")).toMatchObject({ count: 2, open: false });
  });

  it("sorts Completed by completion time with no cap", () => {
    const facts = Array.from({ length: PROJECT_ROW_CAP + 3 }, (_, index) => fact(`c${index}`, { completedMs: NOW - (10 - index) * 1000, activityMs: NOW - index }));
    const model = deriveSidebarModel(inputs({ facts, ui: { scope: "completed" } }));

    expect(threadKeys(model.items)).toEqual(facts.map((entry) => entry.id).reverse());
    expect(model.items.some((item) => item.kind === "show-more")).toBe(false);
    expect(model.scopeBar).toEqual({ visible: true, completedCount: PROJECT_ROW_CAP + 3 });
  });

  it("falls back to Active and hides the scope bar with nothing completed", () => {
    const model = deriveSidebarModel(inputs({ facts: [fact("a")], ui: { scope: "completed" } }));

    expect(model.scope).toBe("active");
    expect(model.scopeBar.visible).toBe(false);
  });

  it("has no Older bar when nothing is Older", () => {
    const model = deriveSidebarModel(inputs({ facts: [fact("a"), fact("b")] }));

    expect(model.olderBar).toBeNull();
    expect(model.items.some((item) => item.kind === "older-bar")).toBe(false);
  });

  it("keeps a holding completion in place, marked completing", () => {
    const facts = [fact("first", { activityMs: NOW - 1000 }), fact("held", { activityMs: NOW - 2000, completedMs: NOW }), fact("last", { activityMs: NOW - 3000 })];
    const completions = new Map<string, PendingCompletion>([["held", { phase: "holding" }]]);
    const model = deriveSidebarModel(inputs({ facts, completions }));

    expect(threadKeys(model.items)).toEqual(["first", "held", "last"]);
    expect(threadItem(model.items, "held")?.pending).toBe("completing");
    expect(model.scopeBar.completedCount).toBe(0);
  });

  it("sets nextBoundaryAt to the earliest crossing into Older", () => {
    const facts = [fact("soon", { activityMs: NOW - 13 * DAY }), fact("later", { activityMs: NOW - 2 * DAY }), fact("needs", { activityMs: NOW - 13.5 * DAY })];
    const model = deriveSidebarModel(inputs({ facts, needsUserIds: new Set(["needs"]) }));

    expect(model.nextBoundaryAt).toBe(NOW - 13 * DAY + 14 * DAY);
    expect(deriveSidebarModel(inputs({ facts, olderAfterDays: null })).nextBoundaryAt).toBeNull();
  });

  it("lists every recent thread flat in the Threads view, drafts first", () => {
    const facts = [fact("a", { activityMs: NOW - 2000 }), fact("b", { workspaceId: "ws-b", activityMs: NOW - 1000, parentId: "a" })];
    const items = deriveSidebarModel(inputs({ facts, draftsByWorkspace: new Map([["ws-b", ["d1"]]]), ui: { view: "threads" } })).items;

    expect(keys(items)).toEqual(["draft:d1", "thread:b", "thread:a", "end-spacer"]);
  });
});

describe("trackNeedsUserEnds", () => {
  it("records the moment a thread leaves the needs-user set and keeps identity otherwise", () => {
    const previous = new Map<string, number>();
    const ended = trackNeedsUserEnds(previous, new Set(["a", "b"]), new Set(["b"]), 42);

    expect(ended).toEqual(new Map([["a", 42]]));
    expect(trackNeedsUserEnds(ended, new Set(["b"]), new Set(["b"]), 99)).toBe(ended);
  });
});

describe("reconcileItems", () => {
  it("returns the previous array when every item is equal", () => {
    const first = deriveSidebarModel(inputs({ facts: [fact("a"), fact("b")] })).items;
    const second = deriveSidebarModel(inputs({ facts: [fact("a"), fact("b")] })).items;

    expect(reconcileItems(first, second)).toBe(first);
  });

  it("keeps unchanged item objects when one item changes", () => {
    const first = deriveSidebarModel(inputs({ facts: [fact("a", { activityMs: NOW - 1 }), fact("b", { activityMs: NOW - 2 })] })).items;
    const completions = new Map<string, PendingCompletion>([["b", { phase: "failed" }]]);
    const next = reconcileItems(first, deriveSidebarModel(inputs({ facts: [fact("a", { activityMs: NOW - 1 }), fact("b", { activityMs: NOW - 2 })], completions })).items);

    expect(next).not.toBe(first);
    expect(threadItem(next, "a")).toBe(threadItem(first, "a"));
    expect(threadItem(next, "b")?.pending).toBe("failed");
  });
});

describe("classifyCause", () => {
  it("treats the first model and a new snapshot epoch as snapshot", () => {
    const base = inputs({ facts: [fact("a")] });

    expect(classifyCause(null, base)).toBe("snapshot");
    expect(classifyCause(base, { ...base, facts: [fact("a", { completedMs: NOW })], snapshotEpoch: 1 })).toBe("snapshot");
  });

  it("treats a data change without a new epoch as push", () => {
    const base = inputs({ facts: [fact("a")] });

    expect(classifyCause(base, { ...base, facts: [fact("a", { completedMs: NOW })] })).toBe("push");
  });

  it("separates layout and clock changes from pushes", () => {
    const base = inputs({ facts: [fact("a")] });

    expect(classifyCause(base, { ...base, ui: { ...base.ui, view: "threads" } })).toBe("layout");
    expect(classifyCause(base, { ...base, now: NOW + 1 })).toBe("clock");
  });

  it("places expand, collapse and Show more without sliding, but slides a freeze change", () => {
    const base = inputs({ facts: [fact("a")] });
    const collapsed = { ...base, ui: { ...base.ui, collapsedProjects: new Set(["ws-1"]) } };

    expect(classifyCause(collapsed, base)).toBe("layout");
    expect(classifyCause(base, collapsed)).toBe("layout");
    expect(classifyCause(base, { ...base, ui: { ...base.ui, showMore: new Set(["ws-1"]) } })).toBe("layout");
    expect(classifyCause(base, { ...base, ui: { ...base.ui, collapsedOlderProjects: new Set(["ws-1"]) } })).toBe("layout");
    expect(classifyCause(base, { ...base, ui: { ...base.ui, frozen: { at: NOW, activityMs: new Map() } } })).toBe("push");
  });
});
