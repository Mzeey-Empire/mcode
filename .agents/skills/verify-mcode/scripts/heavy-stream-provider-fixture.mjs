#!/usr/bin/env node
/** Deterministic local stream through the production Codex app-server adapter. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { parseFixtureArguments } from "./codex-protocol-notices-fixture.mjs";

const root = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function emitTurn(request, notify, turnId) {
  const config = JSON.parse(request.params.input.find((item) => item.type === "text").text);
  const relative = NodePath.relative(NodePath.join(root, ".dev", "perf"), config.statsPath);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) throw new Error("Fixture statistics must stay under .dev/perf");
  const base = { threadId: request.params.threadId, turnId };
  const counts = {};
  const pieces = [];
  const tools = [];
  const send = (method, params) => {
    if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") pieces.push({ index: Number(/piece (\d+)/.exec(params.delta)[1]), at: Date.now() });
    if (method === "item/completed" && params.item.type === "commandExecution") tools.push(params.item.id);
    counts[method] = (counts[method] ?? 0) + 1;
    notify(method, params);
  };
  const startedAt = Date.now();
  const save = (complete) => NodeFS.writeFileSync(config.statsPath, JSON.stringify({ counts, pieces, tools, turnId, startedAt, endedAt: Date.now(), complete }));
  send("turn/started", { threadId: base.threadId, turn: { id: base.turnId, items: [], status: "inProgress", error: null } });
  if (config.grow) {
    for (let index = 0; index < config.grow; index += 1) {
      const item = { id: `${base.turnId}-warm-${index}`, type: "agentMessage", text: `Warm item ${index}\n`, phase: "commentary" };
      send("item/started", { ...base, item: { ...item, text: "" } });
      send("item/completed", { ...base, item });
      if (index % 100 === 0) save(false);
      await pause(10);
      if (Date.now() - startedAt >= 600_000) break;
    }
  } else {
    await emitStream(config, base, send, save, startedAt);
  }
  send("item/completed", { ...base, item: { id: `${base.turnId}-final`, type: "agentMessage", text: "Heavy stream complete.", phase: "final_answer", memoryCitation: null } });
  send("turn/completed", { threadId: base.threadId, turn: { id: base.turnId, items: [], status: "completed", error: null } });
  save(true);
}

async function emitStream(config, base, send, save, startedAt) {
  const total = Math.floor(config.duration * config.rate);
  let active = startSegment(base, send, 0, false);
  for (let index = 0; index < total; index += 1) {
    await pause(Math.max(0, startedAt + index * 1000 / config.rate - Date.now()));
    const reasoning = Math.floor(index / config.rate) % 2 === 1;
    if (active.reasoning !== reasoning) {
      completeSegment(base, send, active);
      active = startSegment(base, send, index, reasoning);
    }
    const delta = `piece ${index}\n`;
    active.text += delta;
    const method = reasoning ? "item/reasoning/summaryTextDelta" : "item/agentMessage/delta";
    send(method, { ...base, itemId: active.item.id, summaryIndex: 0, delta });
    if (isToolIndex(index, total, config.rate)) {
      completeSegment(base, send, active);
      emitTool(base, send, index, index === Math.floor(total / 2));
      active = startSegment(base, send, index + 1, reasoning);
    }
    if (index % config.rate === 0) save(false);
  }
  await pause(Math.max(0, startedAt + config.duration * 1000 - Date.now()));
  completeSegment(base, send, active);
}

function startSegment(base, send, index, reasoning) {
  const id = `${base.turnId}-segment-${index}-${reasoning}`;
  const item = reasoning
    ? { id, type: "reasoning", summary: [] }
    : { id, type: "agentMessage", text: "", phase: "commentary" };
  send("item/started", { ...base, item });
  return { item, reasoning, text: "" };
}

function completeSegment(base, send, active) {
  const item = active.reasoning
    ? { ...active.item, summary: [{ type: "summary_text", text: active.text }] }
    : { ...active.item, text: active.text };
  send("item/completed", { ...base, item });
}

/** Selects periodic tools and the single midpoint output without double emission. */
export function isToolIndex(index, total, rate) {
  return index % (rate * 5) === 0 || index === Math.floor(total / 2);
}

function emitTool(base, send, index, large) {
  const item = { id: `${base.turnId}-${large ? "large-output" : `tool-${index}`}`, type: "commandExecution", command: "fixture echo", cwd: ".", status: "inProgress" };
  const output = large ? "HEAVY_OUTPUT:" + "x".repeat(300 * 1024 - 13) + "\n" : `tool ${index}\n`;
  send("item/started", { ...base, item });
  send("item/commandExecution/outputDelta", { ...base, itemId: item.id, delta: output });
  send("item/completed", { ...base, item: { ...item, status: "completed", aggregatedOutput: output, exitCode: 0, durationMs: 1 } });
}

function main() {
  if (parseFixtureArguments(process.argv.slice(2)).command === "version") {
    process.stdout.write("codex 99.0.0\n");
  } else {
    const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
    const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
    const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
    NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      if (request.method === "thread/start" || request.method === "thread/resume") {
        reply(request.id, { thread: { id: request.params?.threadId ?? NodeCrypto.randomUUID() } });
      } else if (request.method === "turn/start") {
        const turnId = NodeCrypto.randomUUID();
        reply(request.id, { turn: { id: turnId } });
        void emitTurn(request, notify, turnId).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
      } else reply(request.id, {});
    });
  }
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) main();

