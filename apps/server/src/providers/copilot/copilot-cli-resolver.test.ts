import { describe, it, expect } from "vitest";
import { resolveCopilotCli, type ResolverIO } from "./copilot-cli-resolver.js";

/** Builds a seeded ResolverIO. `exec` keys are `[command, ...args].join(" ")`. */
function fakeIO(opts: {
  platform?: NodeJS.Platform;
  files?: Record<string, string>;
  existsExtra?: string[];
  exec?: Record<string, string | null>;
}): ResolverIO {
  const files = opts.files ?? {};
  const existsSet = new Set([...Object.keys(files), ...(opts.existsExtra ?? [])]);
  const execMap = opts.exec ?? {};
  return {
    platform: opts.platform ?? "linux",
    exists: (p) => existsSet.has(p),
    readFile: (p) => (p in files ? files[p]! : null),
    exec: (command, args) => {
      const key = [command, ...args].join(" ");
      return key in execMap ? execMap[key]! : null;
    },
  };
}

describe("resolveCopilotCli", () => {
  it("returns not-found with the @github/copilot install command when nothing resolves", () => {
    const res = resolveCopilotCli({}, fakeIO({ platform: "linux" }));
    expect(res.source).toBe("not-found");
    expect(res.entry).toBeNull();
    expect(res.version).toBeNull();
    if (res.source === "not-found") {
      expect(res.message).toContain("npm install -g @github/copilot");
    }
  });
});

export { fakeIO };
