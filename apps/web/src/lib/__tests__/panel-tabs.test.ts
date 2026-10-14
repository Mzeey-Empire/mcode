import { describe, it, expect } from "vitest";
import { PANEL_TAB_TYPES, shownTabTypes } from "../panel-tabs";
import { rightPanelToolInstance, type RightPanelTool } from "@/stores/diffStore";

/** Pull just the ids out of a result for terse assertions. */
function ids(types: readonly { id: RightPanelTool }[]): RightPanelTool[] {
  return types.map((t) => t.id);
}

describe("PANEL_TAB_TYPES catalog", () => {
  it("gives every shortcut-enabled type a commandId", () => {
    for (const type of PANEL_TAB_TYPES) {
      if (type.id !== "subagents") expect(type.commandId).toBeTruthy();
    }
  });

  it("makes Files a real singleton tool toggled by files.toggle", () => {
    const files = PANEL_TAB_TYPES.find((type) => type.id === "files");
    expect(files?.commandId).toBe("files.toggle");
    expect(files?.needsThread).toBe(false);
    expect(rightPanelToolInstance("files")).toEqual({ id: "singleton:files", type: "files" });
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

describe("shownTabTypes — Files is creatable", () => {
  it("offers Files in both scopes until it is open", () => {
    for (const scope of ["threadless", "thread"] as const) {
      expect(ids(shownTabTypes(scope, []))).toContain("files");
      expect(ids(shownTabTypes(scope, ["files"]))).not.toContain("files");
    }
  });

  it("offers nothing when every tool is open", () => {
    expect(
      ids(shownTabTypes("thread", ["preview", "terminal", "files", "changes", "environment", "tasks", "subagents"])),
    ).toEqual([]);
  });
});

describe("shownTabTypes — purity", () => {
  it("does not mutate the openTabs argument", () => {
    const open: RightPanelTool[] = ["preview"];
    shownTabTypes("thread", open);
    expect(open).toEqual(["preview"]);
  });

  it("returns results in catalog order", () => {
    expect(ids(shownTabTypes("thread", ["tasks", "preview"]))).toEqual([
      "terminal",
      "files",
      "changes",
      "environment",
      "subagents",
    ]);
  });
});
