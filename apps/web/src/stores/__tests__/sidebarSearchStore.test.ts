// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useSidebarSearchStore } from "../sidebarSearchStore";

const STORAGE_KEY = "mcode-sidebar-search-prefs";

afterEach(() => {
  useSidebarSearchStore.getState().setSortField("updated_at");
  localStorage.removeItem(STORAGE_KEY);
});

function storedPrefs(): unknown {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
}

describe("setSortField", () => {
  it("sorts by name A to Z after recent activity sorted descending", () => {
    const store = useSidebarSearchStore.getState();
    store.setSortField("updated_at");
    store.setSortDirection("desc");

    store.setSortField("title");

    expect(useSidebarSearchStore.getState().sortDirection).toBe("asc");
    expect(storedPrefs()).toMatchObject({ sortField: "title", sortDirection: "asc" });
  });

  it("resets to newest first when switching from name to a date field", () => {
    const store = useSidebarSearchStore.getState();
    store.setSortField("title");
    store.setSortDirection("asc");

    store.setSortField("created_at");

    expect(useSidebarSearchStore.getState().sortDirection).toBe("desc");
  });

  it("resets a toggled direction when the current field is chosen again", () => {
    const store = useSidebarSearchStore.getState();
    store.setSortField("title");
    store.toggleSortDirection();
    expect(useSidebarSearchStore.getState().sortDirection).toBe("desc");

    store.setSortField("title");

    expect(useSidebarSearchStore.getState().sortDirection).toBe("asc");
  });
});
