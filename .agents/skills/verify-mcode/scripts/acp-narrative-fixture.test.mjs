import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import {
  FIXTURE_ASSISTANT_TEXT,
  FIXTURE_MODELS_OUTPUT,
  FIXTURE_SESSION_ID,
  FIXTURE_THOUGHT_TEXTS,
  fixtureTurnUpdates,
  parseFixtureArguments,
} from "./acp-narrative-fixture.mjs";
import { parseAcpNarrativeArguments, renderFixtureWrapper } from "./acp-narrative.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixturePath = NodePath.join(scriptDirectory, "acp-narrative-fixture.mjs");

NodeTest.test("fixture emits thought chunks, ordered markers, and out-of-order completions", async () => {
  const agent = startFixture(["acp"]);
  try {
    NodeAssertStrict.deepEqual(await agent.request(1, "initialize", { protocolVersion: 1 }), {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    });
    NodeAssertStrict.deepEqual(await agent.request(2, "authenticate", { methodId: "windsurf-api-key" }), {});
    NodeAssertStrict.deepEqual(await agent.request(3, "session/new", { cwd: "C:/fixture", mcpServers: [] }), { sessionId: FIXTURE_SESSION_ID });
    const prompt = agent.request(4, "session/prompt", { sessionId: FIXTURE_SESSION_ID, prompt: [] });

    const received = await agent.notifications(12);
    const notifications = received.map(({ method, params }) => ({ method, params }));
    NodeAssertStrict.deepEqual(notifications, fixtureTurnUpdates(FIXTURE_SESSION_ID));

    NodeAssertStrict.equal(notifications[0].params.update.sessionUpdate, "agent_thought_chunk");
    NodeAssertStrict.equal(notifications[1].params.update.sessionUpdate, "agent_thought_chunk");
    NodeAssertStrict.equal(notifications[0].params.update.content.text, FIXTURE_THOUGHT_TEXTS[0]);

    const markers = notifications.filter((entry) => entry.params.update.sessionUpdate === "tool_call");
    NodeAssertStrict.deepEqual(markers.map((entry) => entry.params.update.toolCallId), ["fx-read", "fx-search", "fx-bash"]);

    const completions = notifications.filter((entry) => entry.params.update.status === "completed");
    NodeAssertStrict.deepEqual(completions.map((entry) => entry.params.update.toolCallId), ["fx-search", "fx-bash", "fx-read"]);

    const lastChunk = notifications.at(-1).params.update;
    NodeAssertStrict.equal(lastChunk.sessionUpdate, "agent_message_chunk");
    NodeAssertStrict.equal(lastChunk.content.text, FIXTURE_ASSISTANT_TEXT);

    NodeAssertStrict.deepEqual(await prompt, { stopReason: "end_turn" });
  } finally {
    agent.close();
  }
});

NodeTest.test("fixture CLI surface answers models, about, and version probes", () => {
  NodeAssertStrict.deepEqual(parseFixtureArguments(["acp", "--force"]), { command: "acp" });
  NodeAssertStrict.deepEqual(parseFixtureArguments(["models"]), { command: "models" });
  NodeAssertStrict.deepEqual(parseFixtureArguments(["about", "--format", "json"]), { command: "about" });
  NodeAssertStrict.deepEqual(parseFixtureArguments(["--version"]), { command: "version" });
  NodeAssertStrict.throws(() => parseFixtureArguments(["bogus"]));

  const models = NodeChildProcess.spawnSync(process.execPath, [fixturePath, "models"], { encoding: "utf8", windowsHide: true });
  NodeAssertStrict.equal(models.status, 0);
  NodeAssertStrict.equal(models.stdout, FIXTURE_MODELS_OUTPUT);
});

NodeTest.test("control argument parsing mirrors the codex fixture contract", () => {
  NodeAssertStrict.deepEqual(parseAcpNarrativeArguments(["check"]), { command: "check" });
  NodeAssertStrict.deepEqual(parseAcpNarrativeArguments(["cleanup", "--confirm-cleanup"]), { command: "cleanup" });
  NodeAssertStrict.throws(() => parseAcpNarrativeArguments(["cleanup"]));
  NodeAssertStrict.throws(() => parseAcpNarrativeArguments(["setup", "--bogus"]));
  NodeAssertStrict.equal(renderFixtureWrapper("C:/bun.exe", "C:/fixture.mjs"), '@echo off\r\n"C:/bun.exe" "C:/fixture.mjs" %*\r\n');
});

function startFixture(args) {
  const child = NodeChildProcess.spawn(process.execPath, [fixturePath, ...args], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const inbox = [];
  const waiters = [];
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (typeof message.id === "number") {
      pending.get(message.id)?.(message.result);
      return;
    }
    inbox.push(message);
    waiters.shift()?.();
  });
  return {
    request(id, method, params) {
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async notifications(count, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (inbox.length < count) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for ${count} notifications; received ${inbox.length}`);
        await Promise.race([new Promise((resolve) => waiters.push(resolve)), delay(Math.min(100, remaining))]);
      }
      return inbox.slice(0, count);
    },
    close() {
      child.kill();
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
