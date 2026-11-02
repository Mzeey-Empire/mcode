import { describe, expect, it } from "vitest";
import { readMenuTrigger, slashMenuReducer, type SlashMenuState } from "../menu-trigger";

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
