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

  it("uses the configured path verbatim and probes its version", () => {
    const io = fakeIO({
      platform: "win32",
      exec: { "C:/tools/copilot.cmd --version": "GitHub Copilot CLI 1.0.24." },
    });
    const res = resolveCopilotCli({ configuredPath: "C:/tools/copilot.cmd" }, io);
    expect(res).toMatchObject({ source: "configured", entry: "C:/tools/copilot.cmd", version: "1.0.24" });
  });

  it("trusts the configured path even when --version yields no semver", () => {
    const io = fakeIO({ platform: "linux", exec: { "/usr/bin/copilot --version": "weird output" } });
    const res = resolveCopilotCli({ configuredPath: "/usr/bin/copilot" }, io);
    expect(res).toMatchObject({ source: "configured", entry: "/usr/bin/copilot", version: null });
  });

  it("ignores a blank configured path and falls through", () => {
    const res = resolveCopilotCli({ configuredPath: "   " }, fakeIO({}));
    expect(res.source).toBe("not-found");
  });
});

export { fakeIO };
