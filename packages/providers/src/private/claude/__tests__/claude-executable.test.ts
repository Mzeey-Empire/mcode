import { afterEach, describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import sdkMetadata from "../../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" };
import { resolveClaudeExecutable, checkClaudeVersion } from "../claude-executable.js";
import { ClaudeProvider } from "../claude-provider.js";
import { fixtureHost } from "./helpers/provider-fixture.js";

const roots: string[] = [];
function fixture() {
  const base = NodeOS.tmpdir();
  const root = NodeFS.mkdtempSync(NodePath.join(base, "claude-executable-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true }); });

describe("installed Claude executable", () => {
  it("resolves the default command on PATH and preserves absolute paths", () => {
    const root = fixture();
    const executable = NodePath.join(root, process.platform === "win32" ? "claude.EXE" : "claude");
    NodeFS.writeFileSync(executable, "fixture", { mode: 0o755 });
    expect(resolveClaudeExecutable("claude", { PATH: root }, process.platform)).toBe(executable);
    expect(resolveClaudeExecutable("claude", { Path: root }, process.platform)).toBe(executable);
    expect(resolveClaudeExecutable(executable, { PATH: "" }, process.platform)).toBe(executable);
  });
  it("rejects a missing command instead of selecting a bundled executable", () => {
    expect(() => resolveClaudeExecutable("claude-missing-fixture", { PATH: fixture() }, process.platform)).toThrow(/Claude Code is not installed/);
  });
  it("maps a Windows npm shim to cli.js and rejects a broken shim", () => {
    const root = fixture();
    const shim = NodePath.join(root, "claude.cmd");
    NodeFS.writeFileSync(shim, "@echo off");
    expect(() => resolveClaudeExecutable(shim, {}, "win32")).toThrow(/Reinstall Claude Code/);
    const entry = NodePath.join(root, "node_modules/@anthropic-ai/claude-code/cli.js");
    NodeFS.mkdirSync(NodePath.dirname(entry), { recursive: true });
    NodeFS.writeFileSync(entry, "fixture");
    expect(resolveClaudeExecutable(shim, {}, "win32")).toBe(entry);
    const native = NodePath.join(NodePath.dirname(entry), "bin/claude.exe");
    NodeFS.mkdirSync(NodePath.dirname(native), { recursive: true });
    NodeFS.writeFileSync(native, "fixture");
    expect(resolveClaudeExecutable(shim, {}, "win32")).toBe(native);
  });
  it("resolves a WinGet Links launcher", () => {
    const root = fixture();
    const shim = NodePath.join(root, "Links/claude.cmd");
    const native = NodePath.join(root, "Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe");
    for (const file of [shim, native]) {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "fixture");
    }
    expect(resolveClaudeExecutable(shim, {}, "win32")).toBe(native);
  });
  it.each([sdkMetadata.claudeCodeVersion, "999.0.0"])("accepts compatible version %s", async (version) => {
    expect(await checkClaudeVersion(async () => ({ kind: "exited", code: 0, output: `${version} (Claude Code)` }), "claude")).toEqual({ installed: version });
  });
  it("warns about an old version and a failed probe", async () => {
    expect(await checkClaudeVersion(async () => ({ kind: "exited", code: 0, output: "0.0.1 (Claude Code)" }), "claude")).toMatchObject({ installed: "0.0.1", warning: expect.stringContaining("Update Claude Code") });
    expect(await checkClaudeVersion(async () => ({ kind: "failed" }), "claude")).toMatchObject({ installed: null, warning: expect.stringContaining("Could not check") });
  });
  it("reports missing installation and fails completion before starting an SDK query", async () => {
    const provider = new ClaudeProvider(fixtureHost(), { cliPath: NodePath.join(fixture(), "missing.exe"), idleSessionTtlMs: 600_000 });
    expect(await provider.describeStatus()).toMatchObject({ cli: { managedBy: "user", installed: null, problem: expect.stringContaining("Claude Code is not installed") } });
    await expect(provider.complete("hello", "model", process.cwd())).rejects.toThrow(/Claude Code is not installed/);
    await expect(provider.sendTurn({
      turnId: "turn-missing", turnExecutionId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-missing", threadId: "thread-missing", workspaceId: "workspace", message: "hello", cwd: process.cwd(),
      model: "model", permissionMode: "supervised", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
    })).rejects.toThrow(/Claude Code is not installed/);
  });
  it("reads a changed configured path and retries a failed version probe", async () => {
    let version = "";
    let cliPath = NodePath.join(fixture(), "missing.exe");
    const host = fixtureHost();
    host.processes.run = async ({ args }) => ({ stdout: args?.[0] === "--version" ? `${version} (Claude Code)` : "{}", stderr: "" });
    const provider = new ClaudeProvider(host, { get cliPath() { return cliPath; }, idleSessionTtlMs: 600_000 });
    expect((await provider.describeStatus()).cli.resolvedPath).toBeNull();
    cliPath = process.execPath;
    expect(await provider.describeStatus()).toMatchObject({ cli: { installed: null, warning: expect.stringContaining("Could not check"), resolvedPath: process.execPath } });
    version = sdkMetadata.claudeCodeVersion;
    const facts = await provider.describeStatus();
    expect(facts.cli.installed).toBe(sdkMetadata.claudeCodeVersion);
    expect(facts.cli.problem).toBeUndefined();
    expect(facts.cli.warning).toBeUndefined();
  });
});
