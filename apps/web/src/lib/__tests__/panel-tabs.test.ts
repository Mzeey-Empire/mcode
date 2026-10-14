import { describe, it, expect } from "vitest";
import {
  PANEL_TAB_TYPES,
  creatableTypes,
  shownTabTypes,
  type PanelTabTypeId,
} from "../panel-tabs";

/** Pull just the ids out of a result for terse assertions. */
function ids(types: readonly { id: PanelTabTypeId }[]): PanelTabTypeId[] {
  return types.map((t) => t.id);
}

describe("PANEL_TAB_TYPES catalog", () => {
  it("gives every shortcut-enabled type a commandId", () => {
    for (const type of PANEL_TAB_TYPES) {
      if (type.comingSoon) {
        expect(type.commandId).toBeUndefined();
      } else if (type.id !== "subagents") {
        expect(type.commandId).toBeTruthy();
      }
    }
  });
});

describe("shownTabTypes — scope filter", () => {
  it("drops thread-only types when threadless (Review stays, dual-scope)", () => {
    expect(ids(shownTabTypes("threadless", []))).toEqual([
      "preview",
      "terminal",
      "files",
      "changes",
      "environment",
    ]);
  });

  it("keeps every type in a thread", () => {
    expect(ids(shownTabTypes("thread", []))).toEqual([
      "preview",
      "terminal",
      "files",
      "changes",
      "environment",
      "tasks",
      "subagents",
    ]);
  });

});

describe("shownTabTypes — cardinality filter", () => {
  it("drops singletons already open", () => {
    expect(ids(shownTabTypes("threadless", ["preview"]))).toEqual([
      "terminal",
      "files",
      "changes",
      "environment",
    ]);
  });

  it("hides Terminal once it is open, like every other tool", () => {
    expect(ids(shownTabTypes("thread", ["terminal"]))).not.toContain("terminal");
    expect(
      ids(shownTabTypes("thread", ["preview", "terminal", "changes", "environment", "tasks", "subagents"])),
    ).toEqual(["files"]);
  });

  it("ignores open ids that the scope filter already removed", () => {
    // "tasks" is thread-only, so it is dropped by the scope filter regardless of
    // whether it appears in openTabs; the result is unchanged.
    expect(ids(shownTabTypes("threadless", ["tasks"]))).toEqual([
      "preview",
      "terminal",
      "files",
      "changes",
      "environment",
    ]);
  });
});

describe("creatableTypes — coming-soon exclusion", () => {
  it("excludes Files from the creatable set when threadless", () => {
    expect(ids(creatableTypes("threadless", []))).toEqual([
      "preview",
      "terminal",
      "changes",
      "environment",
    ]);
  });

  it("excludes Files from the creatable set in a thread", () => {
    expect(ids(creatableTypes("thread", []))).toEqual([
      "preview",
      "terminal",
      "changes",
      "environment",
      "tasks",
      "subagents",
    ]);
  });

  it("never returns Files regardless of scope or open tabs", () => {
    const scopes = ["threadless", "thread"] as const;
    for (const scope of scopes) {
      expect(ids(creatableTypes(scope, [])).includes("files")).toBe(false);
      expect(ids(creatableTypes(scope, ["preview"])).includes("files")).toBe(false);
    }
  });
});

describe("creatableTypes — combined scope + cardinality", () => {
  it("drops both scope-filtered and already-open types", () => {
    expect(ids(creatableTypes("threadless", ["preview"]))).toEqual([
      "terminal",
      "changes",
      "environment",
    ]);
  });

  it("offers nothing when every tool is open", () => {
    expect(
      ids(creatableTypes("thread", ["preview", "terminal", "changes", "environment", "tasks", "subagents"])),
    ).toEqual([]);
  });

  it("is a strict subset of shownTabTypes (only the coming-soon teaser differs)", () => {
    const shown = ids(shownTabTypes("thread", []));
    const creatable = ids(creatableTypes("thread", []));
    const removed = shown.filter((id) => !creatable.includes(id));
    expect(removed).toEqual(["files"]);
  });
});

describe("creatableTypes / shownTabTypes — purity", () => {
  it("does not mutate the openTabs argument", () => {
    const open: PanelTabTypeId[] = ["preview"];
    creatableTypes("thread", open);
    shownTabTypes("thread", open);
    expect(open).toEqual(["preview"]);
  });

  it("returns results in catalog order", () => {
    // Open tabs given out of order must not reorder the result.
    expect(ids(creatableTypes("thread", ["tasks", "preview"]))).toEqual([
      "terminal",
      "changes",
      "environment",
      "subagents",
    ]);
  });
});
