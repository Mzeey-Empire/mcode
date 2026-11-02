import { describe, expect, it } from "vitest";
import { filterMenuCommands, readMenuTrigger, slashMenuReducer, type SlashMenuState } from "../menu-trigger";

const CLOSED: SlashMenuState = { status: "closed", dismissed: null };

function caret(state: SlashMenuState, nodeKey: string, textBeforeCaret: string): SlashMenuState {
  return slashMenuReducer(state, { type: "caretMoved", trigger: readMenuTrigger(nodeKey, textBeforeCaret) });
}

describe("readMenuTrigger", () => {
  it("finds a slash at the start of a word", () => {
    expect(readMenuTrigger("n1", "please /rev")).toEqual({
      anchor: { nodeKey: "n1", start: 7, key: "/" },
      query: "rev",
      scope: "all",
    });
  });

  it("ignores a slash inside a word", () => {
    expect(readMenuTrigger("n1", "a/b")).toBeNull();
  });

  it("leaves money as text", () => {
    expect(readMenuTrigger("n1", "pay $5")).toBeNull();
    expect(readMenuTrigger("n1", "£20")).toBeNull();
    expect(readMenuTrigger("n1", "₦1,000")).toBeNull();
  });

  it.each(["$", "£", "₦"])("opens skills and plugins from %s", (key) => {
    expect(readMenuTrigger("n1", `ask ${key}rev`)).toEqual({
      anchor: { nodeKey: "n1", start: 4, key },
      query: "rev",
      scope: "skills",
    });
  });
});

describe("slashMenuReducer", () => {
  it("stays closed after Escape while the same word keeps growing", () => {
    const open = caret(CLOSED, "n1", "/re");
    expect(open.status).toBe("open");
    const escaped = slashMenuReducer(open, { type: "escaped" });

    expect(caret(escaped, "n1", "/review").status).toBe("closed");
  });

  it("opens again for a trigger at a new anchor", () => {
    const escaped = slashMenuReducer(caret(CLOSED, "n1", "/re"), { type: "escaped" });

    const reopened = caret(escaped, "n1", "/re /co");

    expect(reopened).toEqual({
      status: "open",
      trigger: { anchor: { nodeKey: "n1", start: 4, key: "/" }, query: "co", scope: "all" },
    });
  });

  it("forgets the dismissed word once the caret leaves every trigger", () => {
    const escaped = slashMenuReducer(caret(CLOSED, "n1", "/re"), { type: "escaped" });
    const left = caret(escaped, "n1", "");

    expect(caret(left, "n1", "/").status).toBe("open");
  });
});

describe("filterMenuCommands", () => {
  const commands = [
    { name: "plan", namespace: "mcode" },
    { name: "review", namespace: "command" },
    { name: "review-pr", namespace: "skill" },
    { name: "github-review", namespace: "plugin" },
  ] as const;

  it("keeps every kind for /", () => {
    expect(filterMenuCommands(commands, { query: "rev", scope: "all" }).map((command) => command.name))
      .toEqual(["review", "review-pr", "github-review"]);
  });

  it("drops command rows for a currency key", () => {
    expect(filterMenuCommands(commands, { query: "", scope: "skills" }).map((command) => command.name))
      .toEqual(["review-pr", "github-review"]);
  });
});
