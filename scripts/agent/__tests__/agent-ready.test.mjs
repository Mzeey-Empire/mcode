/** Tests for the detached runtime readiness command. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHTTP from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { agentReady } from "../agent-ready.mjs";
import { MANAGED_DESKTOP_SESSION_FILE } from "../managed-desktop.mjs";
import { buildPortsContract, getRuntimePaths, writePortsFile } from "../runtime-contract.mjs";

NodeTest.test("agentReady polls contract health and app URLs until both respond", async () => {
  const repo = makeRepo();
  let healthRequests = 0;
  let appRequests = 0;
  const health = await startServer((_request, response) => {
    healthRequests += 1;
    response.writeHead(healthRequests < 2 ? 503 : 200).end();
  });
  const app = await startServer((_request, response) => {
    appRequests += 1;
    response.writeHead(appRequests < 3 ? 503 : 200).end();
  });

  try {
    writeContract(repo, { serverPort: health.port, webPort: app.port });
    const result = await agentReady(repo, { timeoutMs: 1_000, httpOptions: { intervalMs: 5, probeTimeoutMs: 50 } });

    NodeAssertStrict.default.deepEqual(result, { mode: "web" });
    NodeAssertStrict.default.ok(healthRequests >= 2, "health URL was polled from the contract");
    NodeAssertStrict.default.ok(appRequests >= 3, "app URL was polled from the contract");
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady accepts server mode when only health answers", async () => {
  const repo = makeRepo();
  const urls = [];
  const health = await startServer((request, response) => {
    urls.push(request.url);
    response.writeHead(200).end();
  });
  try {
    writeContract(repo, { mode: "server", serverPort: health.port, webPort: null });
    const result = await agentReady(repo, { timeoutMs: 1_000, httpOptions: { intervalMs: 5, probeTimeoutMs: 50 } });
    NodeAssertStrict.default.deepEqual(result, { mode: "server" });
    NodeAssertStrict.default.deepEqual(urls, ["/health"]);
  } finally {
    await closeServer(health.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady still requires the app to answer in web mode", async () => {
  const repo = makeRepo();
  const health = await startServer((_request, response) => response.writeHead(200).end());
  const app = await startServer((_request, response) => response.writeHead(503).end());
  try {
    writeContract(repo, { serverPort: health.port, webPort: app.port });
    await NodeAssertStrict.default.rejects(
      () => agentReady(repo, { timeoutMs: 100, httpOptions: { intervalMs: 5, probeTimeoutMs: 50 } }),
      /web app did not become reachable/,
    );
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady reads the endpoint that Electron's server publishes after startup", async () => {
  const probes = await withManagedDesktopPage((appUrl) => appUrl, async (repo, options, contract) => {
    writePortsFile({ ...contract, serverPort: null, healthUrl: null }, repo);
    const ready = agentReady(repo, options);
    writePortsFile(contract, repo);
    NodeAssertStrict.default.deepEqual(await ready, { mode: "desktop" });
  });
  NodeAssertStrict.default.equal(probes, 1);
});

NodeTest.test("agentReady points to the Electron log when the server never publishes its endpoint", async () => {
  await withManagedDesktopPage((appUrl) => appUrl, async (repo, options, contract) => {
    writePortsFile({ ...contract, serverPort: null, healthUrl: null }, repo);
    await NodeAssertStrict.default.rejects(
      () => agentReady(repo, { ...options, timeoutMs: 25 }),
      /Electron's server has not named itself in \.dev\/ports\.json.*\.dev\/logs\/electron-live-testing\.stderr\.log/,
    );
  });
});

NodeTest.test("agentReady asks to rerun desktop startup when its session record is missing", async () => {
  const repo = makeRepo();
  try {
    writeContract(repo, { mode: "desktop", serverPort: null, webPort: 41_112 });
    await NodeAssertStrict.default.rejects(
      () => agentReady(repo, { timeoutMs: 25, httpOptions: { intervalMs: 5 } }),
      /Managed desktop session record is missing.*agent:up --desktop/,
    );
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady fails at the deadline when a contract endpoint never becomes ready", async () => {
  const repo = makeRepo();
  const health = await startServer((_request, response) => response.writeHead(503).end());
  const app = await startServer((_request, response) => response.writeHead(200).end());

  try {
    writeContract(repo, { serverPort: health.port, webPort: app.port });
    await NodeAssertStrict.default.rejects(
      () => agentReady(repo, { timeoutMs: 60, httpOptions: { intervalMs: 5, probeTimeoutMs: 20 } }),
      /server health did not become reachable/,
    );
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady verifies the managed desktop CDP endpoint and exact app page", async () => {
  const probes = await withManagedDesktopPage((appUrl) => appUrl, async (repo, options) => {
    NodeAssertStrict.default.deepEqual(await agentReady(repo, options), { mode: "desktop" });
  });
  NodeAssertStrict.default.equal(probes, 1);
});

NodeTest.test("agentReady reports the Chromium error page even when CDP lists the app URL", async () => {
  await withManagedDesktopPage(() => "chrome-error://chromewebdata/", async (repo, options, { appUrl }) => {
    await NodeAssertStrict.default.rejects(() => agentReady(repo, options), {
      message: `Electron shows an error page instead of ${appUrl}; see .dev/logs/electron-live-testing.stderr.log`,
    });
  });
});

NodeTest.test("agentReady retries when the Chromium error page is replaced by the app", async () => {
  const probes = await withManagedDesktopPage(
    (appUrl, probe) => probe === 1 ? "chrome-error://chromewebdata/" : appUrl,
    async (repo, options) => {
      NodeAssertStrict.default.deepEqual(await agentReady(repo, options), { mode: "desktop" });
    },
  );
  NodeAssertStrict.default.equal(probes, 2);
});

async function withManagedDesktopPage(locationForProbe, checkReadiness) {
  const repo = makeRepo();
  const health = await startServer((_request, response) => response.writeHead(200).end());
  const app = await startServer((_request, response) => response.writeHead(200).end());
  const contract = writeContract(repo, { mode: "desktop", serverPort: health.port, webPort: app.port });
  let probes = 0;
  const desktop = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/json/version") return Response.json(validCdpVersion(server.port));
      if (path === "/json/list") {
        return Response.json([{
          type: "page",
          url: contract.appUrl,
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/app`,
        }]);
      }
      if (path === "/devtools/page/app" && server.upgrade(request)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const { id, method, params } = JSON.parse(message);
        if (method !== "Runtime.evaluate" || params?.expression !== "location.href" || params?.returnByValue !== true) return;
        const value = locationForProbe(contract.appUrl, ++probes);
        socket.send(JSON.stringify({ id, result: { result: { type: "string", value } } }));
      },
    },
  });

  try {
    const desktopProcess = startOwnedProcess(repo, desktop.port);
    const sessionFile = NodePath.join(getRuntimePaths(repo).devDir, MANAGED_DESKTOP_SESSION_FILE);
    NodeFS.writeFileSync(sessionFile, `${JSON.stringify({
      status: "running",
      repoRoot: repo,
      appUrlPrefix: contract.appUrl,
      debugPort: desktop.port,
      endpoint: `http://127.0.0.1:${desktop.port}`,
      pid: desktopProcess.pid,
      executablePath: process.execPath,
    })}\n`);

    try {
      await checkReadiness(repo, {
        timeoutMs: 1_000,
        httpOptions: { intervalMs: 5, probeTimeoutMs: 50 },
        desktopOptions: { intervalMs: 10, probeTimeoutMs: 200 },
      }, contract);
      return probes;
    } finally {
      stopOwnedProcess(desktopProcess);
    }
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    await desktop.stop(true);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
}

NodeTest.test("agentReady rejects a desktop session whose PID command is not owned", async () => {
  const repo = makeRepo();
  const desktopProcess = startOwnedProcess(repo, 43_001);
  try {
    const contract = writeContract(repo, { mode: "desktop", serverPort: 43_002, webPort: 43_003 });
    const sessionFile = NodePath.join(getRuntimePaths(repo).devDir, MANAGED_DESKTOP_SESSION_FILE);
    NodeFS.writeFileSync(sessionFile, `${JSON.stringify({
      status: "running",
      repoRoot: repo,
      appUrlPrefix: contract.appUrl,
      debugPort: 43_001,
      endpoint: "http://127.0.0.1:43001",
      pid: desktopProcess.pid,
      executablePath: NodePath.join(repo, "not-owned-electron"),
    })}\n`);

    await NodeAssertStrict.default.rejects(() => agentReady(repo), /Managed desktop session belongs to a different worktree or app/);
  } finally {
    stopOwnedProcess(desktopProcess);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady rejects linked runtime paths without reading external contracts", async (test) => {
  const repo = makeRepo();
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-ready-external-"));
  NodeFS.writeFileSync(NodePath.join(external, "sentinel"), "preserve");
  try {
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev"), "junction");
    } catch (error) {
      test.skip(`Links are unavailable: ${error.code}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentReady(repo), /runtime directory must not be a link/);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(external, "sentinel"), "utf8"), "preserve");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady rejects a linked ports file without reading the target", async (test) => {
  const repo = makeRepo();
  const external = NodePath.join(NodeOS.tmpdir(), `agent-ready-contract-${Date.now()}.json`);
  NodeFS.writeFileSync(external, "external contract");
  try {
    NodeFS.mkdirSync(NodePath.join(repo, ".dev"));
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev", "ports.json"), "file");
    } catch (error) {
      test.skip(`Links are unavailable: ${error.code}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentReady(repo), /runtime contract must not be a link/);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(external, "utf8"), "external contract");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { force: true });
  }
});

NodeTest.test("agentReady compares worktree paths with platform case rules", async () => {
  const repo = makeRepo();
  const health = await startServer((_request, response) => response.writeHead(200).end());
  const app = await startServer((_request, response) => response.writeHead(200).end());
  try {
    writeContract(repo, { serverPort: health.port, webPort: app.port, worktreeIdentity: repo.toUpperCase() });
    if (process.platform === "win32") {
      await agentReady(repo, { httpOptions: { intervalMs: 5, probeTimeoutMs: 50 } });
    } else {
      await NodeAssertStrict.default.rejects(() => agentReady(repo), /different worktree/);
    }
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

function writeContract(repo, { mode = "web", serverPort, webPort, worktreeIdentity = repo }) {
  const contract = buildPortsContract({
    repoRoot: repo,
    mode,
    serverPort,
    webPort,
    instanceToken: "a".repeat(64),
    worktreeIdentity,
    seedLogin: {
      email: "agent@seed.local",
      token: "test-token",
      authHeader: "Bearer test-token",
      cookieName: "mcode-auth",
    },
  });
  writePortsFile(contract, repo);
  return contract;
}

function validCdpVersion(port) {
  return {
    Browser: "Electron/37.3.1",
    "Protocol-Version": "1.3",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/session`,
  };
}

function startOwnedProcess(repo, port) {
  const script = NodePath.join(repo, "owned-desktop.mjs");
  NodeFS.writeFileSync(script, "setTimeout(() => {}, 30000);\n");
  return NodeChildProcess.spawn(process.execPath, [script, `--remote-debugging-port=${port}`], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
}

function stopOwnedProcess(child) {
  if (child?.pid && child.exitCode === null) child.kill();
}

function makeRepo() {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-ready-"));
  NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), ".dev/\n");
  return repo;
}

async function startServer(handler) {
  const server = NodeHTTP.createServer(handler);
  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
  return { server, port: address.port };
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}
