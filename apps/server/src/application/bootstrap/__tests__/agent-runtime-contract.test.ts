import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishAgentRuntimeEndpoint, publishServerEndpoint } from "../agent-runtime-contract.js";

describe("publishAgentRuntimeEndpoint", () => {
  let directory: string;
  let path: string;
  const pending = JSON.stringify({
    instanceToken: "worktree-instance",
    worktreeIdentity: "worktree",
    serverPort: null,
    webPort: 41234,
    healthUrl: null,
    appUrl: "http://127.0.0.1:41234",
    seedLogin: { token: "worktree-token", authHeader: "Bearer worktree-token" },
    logsDir: "logs",
  }, null, 2) + "\n";

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-runtime-contract-"));
    path = NodePath.join(directory, "ports.json");
  });

  afterEach(() => {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("publishes the same server in the lock and the contract on startup and restart", () => {
    const lockPath = NodePath.join(directory, "server.lock");
    const endpoint = {
      lockPath,
      contractPath: path,
      authToken: "worktree-token",
      singleInstance: false,
      pid: 12345,
      version: "1.0.0",
      ipcPath: "mcode.sock",
    };
    NodeFS.writeFileSync(path, pending);

    publishServerEndpoint({ ...endpoint, port: 19504 });
    expect(JSON.parse(NodeFS.readFileSync(lockPath, "utf8"))).toMatchObject({
      port: 19504,
      authToken: "worktree-token",
    });
    expect(NodeFS.readFileSync(path, "utf8")).toBe(pending
      .replace('"serverPort": null', '"serverPort": 19504')
      .replace('"healthUrl": null', '"healthUrl": "http://127.0.0.1:19504/health"'));

    NodeFS.writeFileSync(`${path}.tmp`, "{");
    publishServerEndpoint({ ...endpoint, port: 19505 });
    expect(JSON.parse(NodeFS.readFileSync(lockPath, "utf8"))).toMatchObject({
      port: 19505,
      authToken: "worktree-token",
    });
    expect(NodeFS.readFileSync(path, "utf8")).toBe(pending
      .replace('"serverPort": null', '"serverPort": 19505')
      .replace('"healthUrl": null', '"healthUrl": "http://127.0.0.1:19505/health"'));
  });

  it("writes the server lock when no contract path is configured", () => {
    const lockPath = NodePath.join(directory, "server.lock");
    publishServerEndpoint({
      lockPath,
      port: 19504,
      authToken: "worktree-token",
      singleInstance: true,
      pid: 12345,
      version: "1.0.0",
      ipcPath: "mcode.sock",
    });

    expect(NodeFS.readdirSync(directory)).toEqual(["server.lock"]);
    const lock = JSON.parse(NodeFS.readFileSync(lockPath, "utf8"));
    expect(lock.port).toBe(19504);
    expect(lock).not.toHaveProperty("authToken");
  });

  it.each([
    { name: "another runtime's contract", contents: pending, token: "another-token" },
    { name: "invalid JSON", contents: "{", token: "worktree-token" },
  ])("leaves $name untouched", ({ contents, token }) => {
    NodeFS.writeFileSync(path, contents);
    publishAgentRuntimeEndpoint(path, 19504, token);
    expect(NodeFS.readFileSync(path, "utf8")).toBe(contents);
  });

  it("ignores missing and non-regular files", () => {
    publishAgentRuntimeEndpoint(path, 19504, "worktree-token");
    expect(NodeFS.readdirSync(directory)).toEqual([]);

    NodeFS.mkdirSync(path);
    publishAgentRuntimeEndpoint(path, 19504, "worktree-token");
    expect(NodeFS.readdirSync(path)).toEqual([]);
    expect(NodeFS.readdirSync(directory)).toEqual(["ports.json"]);
  });
});
