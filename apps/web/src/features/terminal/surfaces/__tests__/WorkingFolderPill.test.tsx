import { describe, expect, it } from "vitest";
import { splitWorkingFolder } from "../WorkingFolderPill";

describe("splitWorkingFolder", () => {
  it.each([
    ["/work/repo", "/work/", "repo"],
    ["/work/repo/", "/work/", "repo"],
    ["C:\\dev\\mcode", "C:\\dev\\", "mcode"],
    ["C:\\dev\\mcode\\", "C:\\dev\\", "mcode"],
    ["repo", "", "repo"],
    ["/", "", "/"],
  ])("splits %s into parent and name", (path, parent, name) => {
    expect(splitWorkingFolder(path)).toEqual({ parent, name });
  });
});
