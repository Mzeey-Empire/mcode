import { describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { SETTINGS_INDEX } from "../settings-nav";
import { searchSettings, settingLocation, type IndexedSetting } from "../settings-search";
import { settingsGroup, settingsPage } from "../setting-def";
import { notRevertible } from "../setting-value";

const FIXTURE_VALUE = notRevertible("Test fixture.");

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const ids = (query: string, index: readonly IndexedSetting[] = SETTINGS_INDEX) =>
  searchSettings(query, index).map((match) => match.entry.def.id);

const desktopIndex = SETTINGS_INDEX.map((entry) =>
  entry.def.id === "troubleshooting.hardwareAcceleration" ? { ...entry, def: { ...entry.def, exists: () => true } } : entry,
);

describe("searchSettings over the real settings", () => {
  it("finds Hardware acceleration by its synonym gpu", () => {
    expect(ids("gpu", desktopIndex)[0]).toBe("troubleshooting.hardwareAcceleration");
  });

  it("never lists a setting that does not exist on this platform", () => {
    expect(ids("gpu")).not.toContain("troubleshooting.hardwareAcceleration");
    expect(ids("hardware acceleration")).not.toContain("troubleshooting.hardwareAcceleration");
  });

  it("finds closed thread retention by the problem phrase", () => {
    expect(ids("threads deleted too soon")[0]).toBe("threads.retention");
  });

  it("ranks Default open-in app above OpenCode rows for open in", () => {
    const found = ids("open in");
    expect(found[0]).toBe("general.openIn");
    expect(found).toContain("providers.opencode.enabled");
  });

  it("returns both the Cursor provider and the terminal cursor rows for cursor", () => {
    expect(ids("cursor")).toEqual(expect.arrayContaining(["providers.cursor.enabled", "terminal.cursorStyle"]));
  });

  it("does not list a whole group by its title when a direct match exists", () => {
    expect(ids("scrollback behavior")).toEqual(["terminal.scrollback"]);
  });

  it("lists the Terminal page's settings by page name", () => {
    const terminalIds = SETTINGS_INDEX.filter((entry) => entry.def.page === "terminal").map((entry) => entry.def.id);
    expect([...ids("terminal")].sort()).toEqual([...terminalIds].sort());
  });

  it("matches no prefix shorter than three characters", () => {
    expect(ids("co")).toEqual([]);
  });

  it("returns nothing for a blank or stop-word-only query", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("the")).toEqual([]);
  });
});

describe("searchSettings scoring", () => {
  const fixture = settingsPage("general", {
    fontSize: { label: "Font size", hint: "Size of text", group: settingsGroup("Font and cursor"), value: FIXTURE_VALUE, Control: () => null },
    fontColour: { label: "Colour", synonyms: "font tint", value: FIXTURE_VALUE, Control: () => null },
    other: { label: "Other", hint: "Mentions font", value: FIXTURE_VALUE, Control: () => null },
  });
  const index = fixture.all.map((def) => ({ def, pageLabel: "General" }));

  it("weights label and phrase, synonym, and drops hint-only rows when a direct match exists", () => {
    const scores = searchSettings("font", index).map((match) => [match.entry.def.id, match.score]);
    // Label 4 + whole phrase in label 2; synonym 3; the hint-only row (1) is dropped.
    expect(scores).toEqual([
      ["general.fontSize", 6],
      ["general.fontColour", 3],
    ]);
  });

  it("halves a prefix-only match and scales by the share of tokens hit", () => {
    expect(searchSettings("fon", index).map((match) => match.score)[0]).toBeCloseTo(4 * 0.9 * 0.5 + 2 * 0.5);
    // Two tokens, one hit: label 4 x 1/2.
    expect(searchSettings("colour zebra", index).map((match) => match.score)).toEqual([2]);
  });

  it("keeps index order for equal scores", () => {
    const tied = settingsPage("general", { a: { label: "Alpha x", value: FIXTURE_VALUE, Control: () => null }, b: { label: "Beta x", value: FIXTURE_VALUE, Control: () => null } });
    expect(searchSettings("x", tied.all.map((def) => ({ def, pageLabel: "General" }))).map((m) => m.entry.def.id)).toEqual([
      "general.a",
      "general.b",
    ]);
  });

  it("names the page and group as the location", () => {
    expect(settingLocation(index[0])).toEqual(["General", "Font and cursor"]);
    expect(settingLocation(index[1])).toEqual(["General"]);
  });
});
