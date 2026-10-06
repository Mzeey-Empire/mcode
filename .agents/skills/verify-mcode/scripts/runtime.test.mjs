import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { assertRuntimeFreshness, canonicalFrameToLiveEvents, isOpenCodeSessionInvalidatedEvent, isRuntimeHarnessEvidenceFile, openVerificationSocketUrl, runBun } from "./runtime.mjs";

const CLI = NodePath.join(import.meta.dirname, "verify-mcode.mjs");
const BROWSER_PROOF = NodePath.join(import.meta.dirname, "browser-opencode-proof.mjs");
const BUN = process.env.BUN_EXE || "bun";

function runBunCommand(args) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(BUN, args, { stdout: "pipe", stderr: "pipe", windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

NodeTest.test("lists every runtime command through the public wrapper help", async () => {
  const help = await runBunCommand([CLI, "--help"]);

  NodeAssertStrict.equal(help.code, 0);
  NodeAssertStrict.equal(help.stderr, "");
  NodeAssertStrict.match(
    help.stdout,
    /^  runtime <health\|check\|console-audit\|inspect\|live\|worktree-setup\|worktree-setup-cleanup\|diagnostics\|cleanup>$/m,
  );
});

NodeTest.test("lists and validates the OpenCode resume proof contract without a provider call", async () => {
  const help = await runBunCommand([CLI, "runtime", "--help"]);
  const invalid = await runBunCommand([
    CLI,
    "runtime",
    "live",
    "--provider", "opencode",
    "--model", "opencode/not-muse",
    "--scenario", "opencode-resume",
    "--confirm-provider-call",
  ]);

  NodeAssertStrict.equal(help.code, 0);
  NodeAssertStrict.match(help.stdout, /opencode-resume/);
  NodeAssertStrict.equal(invalid.code, 1);
  NodeAssertStrict.match(invalid.stdout, /opencode\/muse-spark-1\.3-contributor-free/);
});

NodeTest.test("rejects invalid runtime check phases before any check runs", async () => {
  const unknown = await runBunCommand([CLI, "runtime", "check", "--phase", "unknown"]);
  const missing = await runBunCommand([CLI, "runtime", "check", "--phase"]);
  const repeated = await runBunCommand([CLI, "runtime", "check", "--phase", "contract", "--phase", "contract"]);

  NodeAssertStrict.equal(unknown.code, 1);
  NodeAssertStrict.match(unknown.stdout, /--phase must be runtime, provider, acp, contract, or ui/);
  NodeAssertStrict.equal(missing.code, 1);
  NodeAssertStrict.match(missing.stdout, /Missing value for --phase/);
  NodeAssertStrict.equal(repeated.code, 1);
  NodeAssertStrict.match(repeated.stdout, /Duplicate phase contract/);
});

NodeTest.test("hides Windows consoles for verification check subprocesses", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-run-bun-"));
  const logPath = NodePath.join(directory, "check.log");
  const bun = globalThis.Bun;
  let options;
  globalThis.Bun = {
    ...bun,
    spawn(value) {
      options = value;
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    },
  };

  try {
    const result = await runBun(directory, ["--version"], logPath);
    NodeAssertStrict.equal(result.exitCode, 0);
    NodeAssertStrict.equal(options.windowsHide, true);
  } finally {
    globalThis.Bun = bun;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

NodeTest.test("runtime freshness includes bundled workspace dependencies but ignores test-only and unrelated files", () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-freshness-"));
  const now = Date.now();
  const bundle = NodePath.join(repo, "apps", "desktop", "dist", "server", "server.cjs");
  const ports = NodePath.join(repo, ".dev", "ports.json");
  const threadDependency = NodePath.join(repo, "packages", "thread-orchestration", "src", "guide.ts");
  const modelDependency = NodePath.join(repo, "packages", "agent-model", "src", "guide.ts");
  const dependencyTest = NodePath.join(repo, "packages", "agent-model", "src", "guide.test.ts");
  const unrelated = NodePath.join(repo, "packages", "unrelated", "src", "guide.ts");

  try {
    writeTimestampedFile(bundle, now);
    writeTimestampedFile(ports, now);
    writeTimestampedFile(threadDependency, now + 5_000);
    NodeAssertStrict.throws(() => assertRuntimeFreshness(repo), /packages\/thread-orchestration\/src\/guide\.ts/);

    NodeFS.rmSync(threadDependency);
    writeTimestampedFile(modelDependency, now);
    NodeAssertStrict.doesNotThrow(() => assertRuntimeFreshness(repo));
    writeTimestampedFile(modelDependency, now + 5_000);
    NodeAssertStrict.throws(() => assertRuntimeFreshness(repo), /packages\/agent-model\/src\/guide\.ts/);

    NodeFS.rmSync(modelDependency);
    writeTimestampedFile(dependencyTest, now + 5_000);
    writeTimestampedFile(unrelated, now + 5_000);
    NodeAssertStrict.doesNotThrow(() => assertRuntimeFreshness(repo));
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("requires confirmation before the browser proof starts Electron", async () => {
  const help = await runBunCommand([BROWSER_PROOF, "--help"]);
  const missingConfirmation = await runBunCommand([BROWSER_PROOF]);

  NodeAssertStrict.equal(help.code, 0);
  NodeAssertStrict.match(help.stdout, /--confirm-provider-call/);
  NodeAssertStrict.notEqual(missingConfirmation.code, 0);
  NodeAssertStrict.match(missingConfirmation.stderr, /--confirm-provider-call is required/);
});

NodeTest.test("cleans only OpenCode resume artifacts created by the runtime verifier", () => {
  NodeAssertStrict.equal(isRuntimeHarnessEvidenceFile("2026-09-04T12-34-56-789Z-opencode-resume-receipt.json"), true);
  NodeAssertStrict.equal(isRuntimeHarnessEvidenceFile("2026-09-04T12-34-56-789Z-opencode-resume-timeline.html"), true);
  NodeAssertStrict.equal(isRuntimeHarnessEvidenceFile("2026-09-04T12-34-56-789Z-opencode-resume-notes.txt"), false);
});

NodeTest.test("recognizes the provider-neutral OpenCode session invalidation subtype", () => {
  NodeAssertStrict.equal(isOpenCodeSessionInvalidatedEvent({ type: "system", subtype: "sdk_session_invalidated" }), true);
  NodeAssertStrict.equal(isOpenCodeSessionInvalidatedEvent({ type: "system", subtype: "opencode:session-recreated" }), false);
});

const THREAD = "e2487eb3-3152-4bfb-b466-1aec64ef7ec5";
const CHILD = "7c0f2d64-1b5e-4c55-9d0b-3f5a1f0e9b21";
const EXECUTION = "660e1a9f-f474-4e6e-8c13-ac64abd4dace";
const EPOCH = "5d3d286f-a6d0-4cdc-b734-2d9fb26eb0d3:a9eafe97-3bdc-4701-ab55-345856cdf877";

// Mirrors one `AcceptedCanonicalAgentEventEnvelopeSchema` envelope captured from a live Claude turn.
function canonicalEnvelope(eventId, sequence, payload, routingThreadId = THREAD) {
  return {
    eventId,
    routing: { threadId: routingThreadId, turnId: "1fe19a18-e38b-4696-853d-8809a04e4a9e", executionId: EXECUTION },
    sourceProviderId: "claude",
    sourceIdentities: [],
    acceptedSequence: sequence,
    serverTimestamps: { acceptedAt: "2026-10-06T09:37:20.543Z" },
    payload,
    progressPosition: { epoch: EPOCH, sequence },
  };
}

function publication(eventId, sequence, event, routingThreadId) {
  return canonicalEnvelope(eventId, sequence, { type: "publication.recorded", publicationId: String(sequence), event: { ...event, publicationId: String(sequence) } }, routingThreadId);
}

NodeTest.test("reads terminal publications from an accepted canonical frame and ignores semantic payloads", () => {
  const frame = {
    phase: "accepted", threadId: THREAD, epoch: EPOCH, from: 26, through: 28,
    events: [
      canonicalEnvelope("e:27", 27, { type: "turn.completed", endedAt: "2026-10-06T09:37:20.543Z" }),
      publication("e:28", 28, { type: "turnComplete", threadId: THREAD, reason: "end_turn", providerId: "claude", turnExecutionId: EXECUTION }),
    ],
  };

  NodeAssertStrict.deepEqual(canonicalFrameToLiveEvents(frame), [
    { eventId: "e:28", threadId: THREAD, type: "turnComplete", turnExecutionId: EXECUTION },
  ]);
});

NodeTest.test("reads stop outcomes and session notices from saved frames", () => {
  const frame = {
    phase: "saved", threadId: THREAD, epoch: EPOCH, through: 9,
    revision: { conversationRevision: 9, rosterRevision: 0 },
    events: [
      { ...publication("e:8", 8, { type: "system", threadId: THREAD, subtype: "sdk_session_invalidated" }), durableRevision: 8 },
      { ...publication("e:9", 9, { type: "ended", threadId: THREAD, turnExecutionId: EXECUTION, outcome: "interrupted" }), durableRevision: 9 },
    ],
  };

  NodeAssertStrict.deepEqual(canonicalFrameToLiveEvents(frame), [
    { eventId: "e:8", threadId: THREAD, type: "system", subtype: "sdk_session_invalidated" },
    { eventId: "e:9", threadId: THREAD, type: "ended", outcome: "interrupted", turnExecutionId: EXECUTION },
  ]);
});

NodeTest.test("reads a recovery frame's durable delta before its retained suffix", () => {
  const frame = {
    phase: "recovery", threadId: THREAD, epoch: EPOCH, acceptedThrough: 2, savedThrough: 1, loss: "none",
    durable: {
      mode: "delta", threadId: THREAD,
      from: { conversationRevision: 0, rosterRevision: 0 }, through: { conversationRevision: 1, rosterRevision: 0 },
      events: [{ ...publication("e:1", 1, { type: "turnStarted", threadId: THREAD, turnExecutionId: EXECUTION }), durableRevision: 1 }],
    },
    retained: [publication("e:2", 2, { type: "turnComplete", threadId: THREAD, turnExecutionId: EXECUTION })],
  };

  NodeAssertStrict.deepEqual(canonicalFrameToLiveEvents(frame).map((event) => event.type), ["turnStarted", "turnComplete"]);
});

NodeTest.test("skips mirrored child frames and publications routed to another thread or execution", () => {
  const events = [
    publication("e:1", 1, { type: "turnComplete", threadId: THREAD, turnExecutionId: EXECUTION }),
    publication("e:2", 2, { type: "turnComplete", threadId: CHILD, turnExecutionId: EXECUTION }),
    publication("e:3", 3, { type: "turnComplete", threadId: THREAD, turnExecutionId: "0b6b2c7e-8f1d-4c3a-9e5f-2a7d4c1b8e90" }),
  ];
  const owned = { phase: "accepted", threadId: THREAD, epoch: EPOCH, from: 0, through: 3, events };

  NodeAssertStrict.deepEqual(canonicalFrameToLiveEvents(owned).map((event) => event.eventId), ["e:1"]);
  NodeAssertStrict.deepEqual(canonicalFrameToLiveEvents({ ...owned, threadId: CHILD, ownerThreadId: THREAD }), []);
});

NodeTest.test("rejects desktop verification sockets without loopback authentication", async () => {
  await NodeAssertStrict.rejects(openVerificationSocketUrl(process.cwd(), "ws://example.test/?token=token"), /loopback WebSocket URL/);
  await NodeAssertStrict.rejects(openVerificationSocketUrl(process.cwd(), "ws://localhost/"), /lacks its authentication token/);
});

NodeTest.test("lost RPC response does not satisfy the next request on the same socket", async () => {
  const serverRequire = NodeModule.createRequire(NodePath.join(process.cwd(), "apps", "server", "package.json"));
  const { WebSocketServer } = serverRequire("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let socket;
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    server.on("connection", (connection) => {
      connection.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        connection.send(JSON.stringify({ id: request.id, result: request.method }));
      });
    });
    socket = await openVerificationSocketUrl(process.cwd(), `ws://127.0.0.1:${server.address().port}/?token=fixture`);
    await socket.sendWithoutResponse("agent.createAndSend", { startupId: "fixture" });
    NodeAssertStrict.equal(await socket.rpc("thread.startup.get", { startupId: "fixture" }), "thread.startup.get");
  } finally {
    await socket?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

function writeTimestampedFile(path, modifiedMs) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "fixture\n");
  NodeFS.utimesSync(path, modifiedMs / 1_000, modifiedMs / 1_000);
}
