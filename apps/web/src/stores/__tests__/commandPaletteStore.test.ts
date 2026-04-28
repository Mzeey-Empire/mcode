import { describe, it, expect, beforeEach } from "vitest";
import { useCommandPaletteStore } from "../commandPaletteStore";

beforeEach(() => useCommandPaletteStore.getState().close());

describe("commandPaletteStore", () => {
  it("open() pushes the root view", () => {
    useCommandPaletteStore.getState().open();
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    expect(useCommandPaletteStore.getState().viewStack).toEqual([{ kind: "root" }]);
  });

  it("open({ intent: 'projects' }) pushes the projects view", () => {
    useCommandPaletteStore.getState().open({ intent: "projects" });
    expect(useCommandPaletteStore.getState().viewStack).toEqual([{ kind: "projects" }]);
  });

  it("push/pop maintain a stack", () => {
    useCommandPaletteStore.getState().open();
    useCommandPaletteStore.getState().push({ kind: "addProject", path: "~/" });
    expect(useCommandPaletteStore.getState().viewStack.length).toBe(2);
    useCommandPaletteStore.getState().pop();
    expect(useCommandPaletteStore.getState().viewStack).toEqual([{ kind: "root" }]);
  });

  it("pop on single-item stack closes the palette", () => {
    useCommandPaletteStore.getState().open();
    useCommandPaletteStore.getState().pop();
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it("close() empties the stack and resets query", () => {
    useCommandPaletteStore.getState().open();
    useCommandPaletteStore.getState().setQuery("foo");
    useCommandPaletteStore.getState().close();
    expect(useCommandPaletteStore.getState()).toMatchObject({ isOpen: false, viewStack: [], query: "" });
  });
});
