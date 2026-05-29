import { describe, it, expect } from "vitest";
import { join } from "node:path";
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

  it("resolves @github/copilot via npm root -g to index.js, version from package.json", () => {
    const pkgDir = join("/global", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      exec: { "npm root -g": "/global" },
      files: { [join(pkgDir, "package.json")]: JSON.stringify({ version: "1.0.24" }) },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res).toMatchObject({ source: "npm-global", entry, version: "1.0.24" });
  });

  it("falls through when npm root -g resolves but index.js is absent", () => {
    const pkgDir = join("/global", "@github", "copilot");
    const io = fakeIO({
      platform: "linux",
      exec: { "npm root -g": "/global" },
      files: { [join(pkgDir, "package.json")]: JSON.stringify({ version: "1.0.24" }) },
    });
    expect(resolveCopilotCli({}, io).source).toBe("not-found");
  });

  it("falls through when npm is unavailable", () => {
    expect(resolveCopilotCli({}, fakeIO({ platform: "linux" })).source).toBe("not-found");
  });

  it("follows a win32 .ps1 shim to the adjacent package index.js (PowerShell-aware)", () => {
    const binDir = join("C:/scoop/bin");
    const shim = join(binDir, "copilot.ps1");
    const pkgDir = join(binDir, "node_modules", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "win32",
      exec: { "powershell -NoProfile -Command (Get-Command copilot).Source": shim },
      files: { [join(pkgDir, "package.json")]: JSON.stringify({ version: "1.0.24" }) },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res).toMatchObject({ source: "path-shim", entry, version: "1.0.24" });
  });

  it("resolves via posix which, following to the adjacent package index.js", () => {
    const binDir = "/usr/local/bin";
    const shim = join(binDir, "copilot");
    const pkgDir = join(binDir, "node_modules", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      exec: { "which copilot": shim },
      files: { [join(pkgDir, "package.json")]: JSON.stringify({ version: "1.0.24" }) },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res).toMatchObject({ source: "path-shim", entry, version: "1.0.24" });
  });

  it("falls through when the shim has no adjacent package", () => {
    const io = fakeIO({ platform: "linux", exec: { "which copilot": "/usr/local/bin/copilot" } });
    expect(resolveCopilotCli({}, io).source).toBe("not-found");
  });
});

export { fakeIO };
