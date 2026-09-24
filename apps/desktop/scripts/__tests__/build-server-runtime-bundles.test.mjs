import { afterEach, describe, expect, it } from "vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import {
  buildServerRuntimeBundles,
  compileServerWithSwc,
} from "../../../../scripts/build-server-dev-bundle.mjs";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../..");

describe("buildServerRuntimeBundles", () => {
  let fixtureRoot;

  afterEach(async () => {
    if (fixtureRoot) await NodeFSPromises.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("compiles the server entry as valid CommonJS", async () => {
    const serverRoot = NodePath.join(repoRoot, "apps/server");
    const distTsc = NodePath.join(serverRoot, "dist-tsc");
    const outputRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "server-entry-cjs-"));
    const serverOutFile = NodePath.join(outputRoot, "server.cjs");
    const ptyHostOutFile = NodePath.join(outputRoot, "pty-host.cjs");
    const providerEventWorkerOutFile = NodePath.join(outputRoot, "provider-event.worker.cjs");
    const canonicalWriterWorkerOutFile = NodePath.join(outputRoot, "canonical-agent-writer.worker.cjs");
    const executionWorkerOutFile = NodePath.join(outputRoot, "execution.worker.cjs");

    try {
      compileServerWithSwc(serverRoot);
      await buildServerRuntimeBundles({
        serverRoot,
        serverOutFile,
        ptyHostOutFile,
      });
      const bundledEntry = await NodeFSPromises.readFile(serverOutFile, "utf8");

      expect(() => new NodeVM.Script(bundledEntry, { filename: "server.cjs" })).not.toThrow();
      await NodeFSPromises.access(providerEventWorkerOutFile);
      await NodeFSPromises.access(canonicalWriterWorkerOutFile);
      await NodeFSPromises.access(executionWorkerOutFile);
      expect(await NodeFSPromises.readFile(executionWorkerOutFile, "utf8")).toContain("writer-request");
      expect(await NodeFSPromises.readFile(serverOutFile, "utf8")).toContain("provider-event.worker.cjs");
      expect(startAndCloseBundledWorker(executionWorkerOutFile)).toBe("ready,closed");
    } finally {
      await NodeFSPromises.rm(outputRoot, { recursive: true, force: true });
      await NodeFSPromises.rm(distTsc, { recursive: true, force: true });
    }
  }, 30_000);

  it("emits separate server and PTY host bundles", async () => {
    fixtureRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "server-runtime-bundles-"));
    const serverRoot = NodePath.join(fixtureRoot, "server");
    const serverEntry = NodePath.join(serverRoot, "dist-tsc", "index.js");
    const ptyHostEntry = NodePath.join(
      serverRoot,
      "dist-tsc",
      "features",
      "terminal",
      "host",
      "pty-host-entry.js",
    );
    const providerEventWorkerEntry = NodePath.join(
      serverRoot,
      "dist-tsc",
      "features",
      "providers",
      "composition",
      "provider-event.worker.js",
    );
    const canonicalWriterWorkerEntry = NodePath.join(
      serverRoot,
      "dist-tsc",
      "features",
      "agents",
      "canonical",
      "canonical-agent-writer.worker.js",
    );
    const executionWorkerEntry = NodePath.join(
      serverRoot,
      "dist-tsc",
      "features",
      "agents",
      "execution",
      "execution.worker.js",
    );
    const serverOutFile = NodePath.join(fixtureRoot, "dist", "server.cjs");
    const ptyHostOutFile = NodePath.join(fixtureRoot, "dist", "pty-host.cjs");
    const providerEventWorkerOutFile = NodePath.join(fixtureRoot, "dist", "provider-event.worker.cjs");
    const canonicalWriterWorkerOutFile = NodePath.join(fixtureRoot, "dist", "canonical-agent-writer.worker.cjs");
    const executionWorkerOutFile = NodePath.join(fixtureRoot, "dist", "execution.worker.cjs");

    await Promise.all([
      NodeFSPromises.mkdir(NodePath.dirname(ptyHostEntry), { recursive: true }),
      NodeFSPromises.mkdir(NodePath.dirname(providerEventWorkerEntry), { recursive: true }),
      NodeFSPromises.mkdir(NodePath.dirname(canonicalWriterWorkerEntry), { recursive: true }),
      NodeFSPromises.mkdir(NodePath.dirname(executionWorkerEntry), { recursive: true }),
    ]);
    await NodeFSPromises.writeFile(serverEntry, 'console.log("server-entry");\n');
    await NodeFSPromises.writeFile(ptyHostEntry, 'console.log("pty-host-entry");\n');
    await NodeFSPromises.writeFile(providerEventWorkerEntry, 'console.log("provider-event-worker");\n');
    await NodeFSPromises.writeFile(canonicalWriterWorkerEntry, 'console.log("canonical-writer-worker");\n');
    await NodeFSPromises.writeFile(executionWorkerEntry, 'console.log("execution-worker");\n');

    await buildServerRuntimeBundles({
      serverRoot,
      serverOutFile,
      ptyHostOutFile,
      production: true,
    });

    await NodeFSPromises.access(serverOutFile);
    await NodeFSPromises.access(ptyHostOutFile);
    await NodeFSPromises.access(providerEventWorkerOutFile);
    await NodeFSPromises.access(canonicalWriterWorkerOutFile);
    await NodeFSPromises.access(executionWorkerOutFile);
    expect(await NodeFSPromises.readFile(serverOutFile, "utf8")).toContain("server-entry");
    expect(await NodeFSPromises.readFile(ptyHostOutFile, "utf8")).toContain("pty-host-entry");
    expect(await NodeFSPromises.readFile(providerEventWorkerOutFile, "utf8")).toContain("provider-event-worker");
    expect(await NodeFSPromises.readFile(canonicalWriterWorkerOutFile, "utf8")).toContain("canonical-writer-worker");
    expect(await NodeFSPromises.readFile(executionWorkerOutFile, "utf8")).toContain("execution-worker");
  }, 30_000);
});

function startAndCloseBundledWorker(workerPath) {
  const script = `
    import { pathToFileURL } from "node:url";
    const worker = new Worker(pathToFileURL(process.env.MCODE_TEST_EXECUTION_WORKER), { type: "module", ref: true });
    const received = [];
    const timer = setTimeout(() => { worker.terminate(); process.exit(1); }, 3000);
    worker.onmessage = (event) => {
      received.push(event.data.kind);
      if (event.data.kind === "ready") worker.postMessage({ kind: "close" });
      if (event.data.kind === "closed") {
        clearTimeout(timer);
        worker.terminate();
        process.stdout.write(received.join(","));
      }
    };
    worker.onerror = () => { clearTimeout(timer); process.exit(1); };
  `;
  return NodeChildProcess.execFileSync("bun", ["-e", script], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, MCODE_TEST_EXECUTION_WORKER: workerPath },
  });
}
