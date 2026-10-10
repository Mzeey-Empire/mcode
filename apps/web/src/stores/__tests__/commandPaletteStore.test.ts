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

  it("open({ intent: 'threadSearch' }) pushes the thread-search view", () => {
    useCommandPaletteStore.getState().open({ intent: "threadSearch" });
    expect(useCommandPaletteStore.getState().viewStack).toEqual([{ kind: "threadSearch" }]);
  });

  it("push/pop maintain a stack", () => {
    useCommandPaletteStore.getState().open();
    useCommandPaletteStore.getState().push({ kind: "projects" });
    expect(useCommandPaletteStore.getState().viewStack.length).toBe(2);
    useCommandPaletteStore.getState().pop();
    expect(useCommandPaletteStore.getState().viewStack).toEqual([{ kind: "root" }]);
  });

  it("open({ intent: 'addProject' }) opens the sources view with an empty query", () => {
    useCommandPaletteStore.getState().setQuery("~/stale");
    useCommandPaletteStore.getState().open({ intent: "addProject" });
    const state = useCommandPaletteStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.viewStack).toEqual([{ kind: "sources" }]);
    expect(state.query).toBe("");
  });

  it("open({ intent: 'addProject', path }) browses that folder from the sources view", () => {
    useCommandPaletteStore.getState().open({ intent: "addProject", path: "C:\\Users\\me\\proj" });
    const state = useCommandPaletteStore.getState();
    expect(state.viewStack).toEqual([{ kind: "sources" }]);
    expect(state.query).toBe("C:\\Users\\me\\proj\\");
  });

  it("open({ intent: 'addProject', path }) keeps POSIX and already-terminated paths as directories", () => {
    useCommandPaletteStore.getState().open({ intent: "addProject", path: "/home/me/proj" });
    expect(useCommandPaletteStore.getState().query).toBe("/home/me/proj/");

    useCommandPaletteStore.getState().open({ intent: "addProject", path: "C:\\" });
    expect(useCommandPaletteStore.getState().query).toBe("C:\\");
  });

  it("open() after a path-seeded open starts with an empty query", () => {
    useCommandPaletteStore.getState().open({ intent: "addProject", path: "/home/me/proj" });
    useCommandPaletteStore.getState().open({ intent: "threadSearch" });
    expect(useCommandPaletteStore.getState().query).toBe("");
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
