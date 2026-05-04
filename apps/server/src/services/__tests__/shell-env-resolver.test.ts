import { describe, it, expect } from "vitest";
import { flattenProcessEnv, parseNullDelimitedEnv } from "../shell-env-utils.js";

describe("shell-env-resolver helpers", () => {
  it("parseNullDelimitedEnv splits on NUL and supports = in values", () => {
    const buf = Buffer.from("A=1\0B=x=y\0", "utf8");
    expect(parseNullDelimitedEnv(buf)).toEqual({ A: "1", B: "x=y" });
  });

  it("flattenProcessEnv drops undefined entries", () => {
    const env = { X: "a", Y: undefined } as NodeJS.ProcessEnv;
    expect(flattenProcessEnv(env)).toEqual({ X: "a" });
  });
});
