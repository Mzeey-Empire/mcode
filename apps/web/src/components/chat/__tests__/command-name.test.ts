import { describe, it, expect } from "vitest";
import { shortenPathPrefixedName } from "../command-name";

describe("shortenPathPrefixedName", () => {
  it("collapses a Windows absolute-path prefix to its basename", () => {
    expect(
      shortenPathPrefixedName("C:\\Users\\u\\repo\\fixture-repo:prototype"),
    ).toBe("fixture-repo:prototype");
  });

  it("collapses a POSIX path prefix", () => {
    expect(shortenPathPrefixedName("/home/u/repo:deploy")).toBe("repo:deploy");
  });

  it("leaves non-path prefixes alone", () => {
    expect(shortenPathPrefixedName("claude:prototype")).toBe("claude:prototype");
    expect(shortenPathPrefixedName("superpowers:pm")).toBe("superpowers:pm");
  });

  it("leaves unprefixed and bare-drive names alone", () => {
    expect(shortenPathPrefixedName("prototype")).toBe("prototype");
    expect(shortenPathPrefixedName("C:thing")).toBe("C:thing");
  });
});
