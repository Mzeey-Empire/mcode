import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ShellEnvResolver } from "../shell-env-resolver.js";
import type { ProcessStartRunner } from "../../process/process-start.js";
import {
  flattenProcessEnv,
  parseNewlineDelimitedEnv,
  parseNullDelimitedEnv,
} from "../shell-env-utils.js";

describe("ShellEnvResolver", () => {
  it("decodes the registry overlay and retains it after a failed refresh", async () => {
    const run = vi.fn<ProcessStartRunner>()
      .mockResolvedValueOnce({ stdout: Buffer.from("PATH=C:/tools\0VALUE=x=y\0").toString("base64"), stderr: "" })
      .mockRejectedValueOnce(new Error("unavailable"));
    const resolver = new ShellEnvResolver({ platform: "win32" }, run);

    expect(await resolver.resolveFreshAsync()).toEqual({ PATH: "C:/tools", VALUE: "x=y" });
    expect(await resolver.resolveFreshAsync()).toEqual({ PATH: "C:/tools", VALUE: "x=y" });
  });

  it("parses NUL-delimited login shell output", async () => {
    const run = vi.fn<ProcessStartRunner>().mockResolvedValue({ stdout: "A=one\nline\0B=x=y\0", stderr: "" });
    const resolver = new ShellEnvResolver({ platform: "linux" }, run);

    expect(await resolver.resolveFreshAsync()).toEqual({ A: "one\nline", B: "x=y" });
  });

  it("falls back to newline output when env -0 is unsupported", async () => {
    const run = vi.fn<ProcessStartRunner>()
      .mockRejectedValueOnce(new Error("unsupported"))
      .mockResolvedValueOnce({ stdout: "A=1\nB=x=y\n", stderr: "" });
    const resolver = new ShellEnvResolver({ platform: "darwin" }, run);

    expect(await resolver.resolveFreshAsync()).toEqual({ A: "1", B: "x=y" });
  });
});

describe("shell-env-utils", () => {
  describe("parseNullDelimitedEnv", () => {
    it("splits on NUL and supports = in values", () => {
      const buf = Buffer.from("A=1\0B=x=y\0", "utf8");
      expect(parseNullDelimitedEnv(buf)).toEqual({ A: "1", B: "x=y" });
    });

    it("returns empty object for empty buffer", () => {
      expect(parseNullDelimitedEnv(Buffer.alloc(0))).toEqual({});
    });

    it("skips entries without = separator", () => {
      const buf = Buffer.from("A=1\0NOEQ\0B=2\0", "utf8");
      expect(parseNullDelimitedEnv(buf)).toEqual({ A: "1", B: "2" });
    });
  });

  describe("parseNewlineDelimitedEnv", () => {
    it("splits on newlines and supports = in values", () => {
      expect(parseNewlineDelimitedEnv("A=1\nB=x=y\n")).toEqual({
        A: "1",
        B: "x=y",
      });
    });

    it("returns empty object for empty string", () => {
      expect(parseNewlineDelimitedEnv("")).toEqual({});
    });

    it("skips lines without = separator", () => {
      expect(parseNewlineDelimitedEnv("A=1\nNOEQ\nB=2\n")).toEqual({
        A: "1",
        B: "2",
      });
    });

    it("handles values containing = characters", () => {
      expect(parseNewlineDelimitedEnv("FORMULA=a=b=c\n")).toEqual({
        FORMULA: "a=b=c",
      });
    });
  });

  describe("flattenProcessEnv", () => {
    it("drops undefined entries", () => {
      const env = { X: "a", Y: undefined } as NodeJS.ProcessEnv;
      expect(flattenProcessEnv(env)).toEqual({ X: "a" });
    });

    it("preserves empty string values", () => {
      const env = { EMPTY: "" } as NodeJS.ProcessEnv;
      expect(flattenProcessEnv(env)).toEqual({ EMPTY: "" });
    });
  });
});
