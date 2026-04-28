import { describe, it, expect } from "vitest";
import {
  normalizeQuery,
  rankSearchFieldMatch,
  filterCommandPaletteGroups,
  buildProjectActionItems,
} from "../CommandPalette.logic";

describe("normalizeQuery", () => {
  it("trims, lowercases, collapses whitespace", () => {
    expect(normalizeQuery("  Foo   BAR ")).toBe("foo bar");
  });
  it("returns empty string for blank input", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("rankSearchFieldMatch", () => {
  it("exact match returns 3", () => {
    expect(rankSearchFieldMatch("foo", "foo")).toBe(3);
  });
  it("prefix match returns 2", () => {
    expect(rankSearchFieldMatch("foobar", "foo")).toBe(2);
  });
  it("substring match returns 1", () => {
    expect(rankSearchFieldMatch("xfooy", "foo")).toBe(1);
  });
  it("no match returns -Infinity", () => {
    expect(rankSearchFieldMatch("nope", "foo")).toBe(-Infinity);
  });
  it("is case-insensitive", () => {
    expect(rankSearchFieldMatch("FOO", "foo")).toBe(3);
  });
});

describe("buildProjectActionItems", () => {
  const ws = {
    id: 1,
    name: "mcode",
    path: "/src/mcode",
    pinned: false,
    lastOpenedAt: null,
    isGitRepo: true,
    createdAt: 0,
    updatedAt: 0,
  };

  it("emits one item per workspace", () => {
    const out = buildProjectActionItems([ws]);
    expect(out).toHaveLength(1);
  });

  it("uses name + path as searchTerms", () => {
    const out = buildProjectActionItems([ws]);
    expect(out[0].searchTerms).toEqual(["mcode", "/src/mcode"]);
  });

  it("sets title to workspace name", () => {
    const out = buildProjectActionItems([ws]);
    expect(out[0].title).toBe("mcode");
  });

  it("sets description to workspace path", () => {
    const out = buildProjectActionItems([ws]);
    expect(out[0].description).toBe("/src/mcode");
  });
});

describe("filterCommandPaletteGroups", () => {
  const groups = [
    {
      heading: "Actions",
      items: [
        { value: "open-settings", title: "Open Settings", searchTerms: ["open settings", "settings"], description: undefined },
        { value: "new-thread", title: "New Thread", searchTerms: ["new thread", "thread"], description: undefined },
      ],
    },
  ];

  it("returns all groups when query is empty", () => {
    const result = filterCommandPaletteGroups(groups, "");
    expect(result[0].items).toHaveLength(2);
  });

  it("filters items by search term", () => {
    const result = filterCommandPaletteGroups(groups, "settings");
    expect(result[0].items).toHaveLength(1);
    expect(result[0].items[0].value).toBe("open-settings");
  });

  it("drops empty groups after filtering", () => {
    const result = filterCommandPaletteGroups(groups, "zzznomatch");
    expect(result).toHaveLength(0);
  });
});
