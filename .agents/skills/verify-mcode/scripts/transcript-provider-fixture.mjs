#!/usr/bin/env node
/** Emits controlled transcript turns through the production Codex protocol boundary. */
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import { FIXTURE_TURN_DELAY_MS, parseFixtureArguments } from "./codex-protocol-notices-fixture.mjs";

const args = parseFixtureArguments(process.argv.slice(2));
if (args.command === "version") {
  process.stdout.write("codex 99.0.0\n");
} else {
  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const running = new Set();
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  input.on("line", (line) => {
    if (line.length > 200_000) return;
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (!request || request.id === undefined || typeof request.method !== "string") return;
    if (request.method === "thread/start" || request.method === "thread/resume") {
      reply(request.id, { thread: { id: fixtureThreadId(request) } });
    } else if (request.method === "turn/start") {
      startTurn(request);
    } else {
      reply(request.id, {});
    }
  });

  function startTurn(request) {
      const threadId = request.params?.threadId;
      if (typeof threadId !== "string") {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Fixture requires a thread ID" } });
        return;
      }
      if (running.has(threadId)) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Fixture turn still running" } });
        return;
      }
      running.add(threadId);
      const turnId = NodeCrypto.randomUUID();
      const text = request.params?.input?.find((item) => item.type === "text")?.text ?? "";
      const long = text.includes("long narrative");
      reply(request.id, { turn: { id: turnId } });
      void emitTurn(notify, threadId, turnId, long, text.includes("overlapping commands"), text.includes("activity label verification"), text.includes("shell card verification"), text.includes("mermaid streaming")).finally(() => {
        running.delete(threadId);
      });
  }
}

function fixtureThreadId(request) {
  return request.method === "thread/resume" && typeof request.params?.threadId === "string"
    ? request.params.threadId : NodeCrypto.randomUUID();
}

async function emitTurn(notify, threadId, turnId, long, overlapping, activity, shellCards, mermaid) {
  await new Promise((resolve) => setTimeout(resolve, FIXTURE_TURN_DELAY_MS));
  const turn = (status) => ({ id: turnId, items: [], status, error: null });
  const base = { threadId, turnId };
  notify("turn/started", { threadId, turn: turn("inProgress") });
  if (mermaid) {
    await emitMermaidStream(notify, base);
    notify("turn/completed", { threadId, turn: turn("completed") });
    return;
  }
  if (activity) await emitActivityLabels(notify, base);
  if (overlapping) await emitOverlappingCommands(notify, base);
  if (shellCards) await emitShellCards(notify, base);
  for (let index = 0; index < (overlapping || activity || shellCards ? 0 : long ? 120 : 3); index += 1) {
    const id = `${turnId}-step-${index}`;
    const text = `Fixture step ${index + 1}: inspect the transcript, preserve message order, and retain the reading position.\n\n`;
    notify("item/started", { ...base, item: { id, type: "agentMessage", text: "", phase: "commentary" } });
    notify("item/agentMessage/delta", { ...base, itemId: id, delta: text });
    notify("item/completed", { ...base, item: { id, type: "agentMessage", text, phase: "commentary", memoryCitation: null } });
    const command = { id: `${id}-tool`, type: "commandExecution", command: "fixture transcript inspection", cwd: ".", status: "inProgress" };
    notify("item/started", { ...base, item: command });
    notify("item/completed", { ...base, item: { ...command, status: "completed", aggregatedOutput: `Fixture result ${index + 1}`, exitCode: 0, durationMs: 1 } });
    await new Promise((resolve) => setTimeout(resolve, long ? 50 : 5));
  }
  emitFinalAnswer(notify, base, turnId);
  notify("turn/completed", { threadId, turn: turn("completed") });
}

function emitFinalAnswer(notify, base, turnId) {
  const id = `${turnId}-answer`;
  const text = `Fixture answer: ${turnId}. Transcript inspection completed. This answer must remain after its user message and narrative.\n\n`.repeat(4);
  notify("item/started", { ...base, item: { id, type: "agentMessage", text: "", phase: "final_answer" } });
  for (const delta of text.matchAll(/.{1,80}/gs)) {
    notify("item/agentMessage/delta", { ...base, itemId: id, delta: delta[0] });
  }
  notify("item/completed", { ...base, item: { id, type: "agentMessage", text, phase: "final_answer", memoryCitation: null } });
}

/**
 * Streams a final answer that exercises every streaming-block state:
 * an open mermaid fence, a closed mermaid fence plus a closed code fence, an
 * open table, and finally a closed table with trailing prose. The holds keep
 * the turn in progress so a renderer can be checked at each stage.
 */
async function emitMermaidStream(notify, base) {
  const id = `${base.turnId}-answer`;
  const send = (delta) => notify("item/agentMessage/delta", { ...base, itemId: id, delta });
  const hold = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stage1 = "Here is the requested diagram.\n\n```mermaid\ngraph TD;\n  A[Streamed] --";
  const stage2 = "> B[Rendered];\n```\n\n```ts\ninterface Turn {\n  id: string;\n}\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |";
  const stage3 = "\n| 3 | 4 |\n\nStreaming continues after the diagram closes.";
  notify("item/started", { ...base, item: { id, type: "agentMessage", text: "", phase: "final_answer" } });
  send(stage1);
  await hold(12000);
  send(stage2);
  await hold(15000);
  send(stage3);
  notify("item/completed", { ...base, item: { id, type: "agentMessage", text: stage1 + stage2 + stage3, phase: "final_answer", memoryCitation: null } });
}

async function emitShellCards(notify, base) {
  const outputs = [
    Array.from({ length: 40 }, (_, i) => `row ${i + 1}\t${"wide output  ".repeat(16)}`).join("\n") + "\n",
    "Fixture command failed\n",
    "Completion event capture ready",
  ];
  for (let index = 0; index < outputs.length; index += 1) {
    const item = { id: `${base.turnId}-shell-${index}`, type: "commandExecution", command: index === 2 ? "" : `echo shell-card-${index + 1}`, cwd: ".", status: "inProgress" };
    notify("item/started", { ...base, item });
    notify("item/commandExecution/outputDelta", { ...base, itemId: item.id, delta: outputs[index] });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    notify("item/completed", { ...base, item: { ...item, status: index === 1 ? "failed" : "completed", aggregatedOutput: outputs[index], exitCode: index === 1 ? 2 : 0, durationMs: 5000 } });
  }
}

async function emitActivityLabels(notify, base) {
  const id = `${base.turnId}-reasoning`;
  notify("item/started", { ...base, item: { id, type: "reasoning", summary: [] } });
  notify("item/reasoning/summaryTextDelta", { ...base, itemId: id, summaryIndex: 0, delta: "**Inspecting layout**\n\nChecking the current view." });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const item = { id: `${base.turnId}-tool`, type: "dynamicToolCall", name: "fixture_inspection", arguments: { description: "Reading settings.ts" }, status: "inProgress" };
  notify("item/started", { ...base, item });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  notify("item/completed", { ...base, item: { ...item, status: "completed", contentItems: [], success: true } });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  notify("item/reasoning/summaryTextDelta", { ...base, itemId: id, summaryIndex: 1, delta: "\n\n**Checking tests**\n\nChecking the final state." });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  notify("item/completed", { ...base, item: { id, type: "reasoning", summary: [] } });
}

async function emitOverlappingCommands(notify, base) {
  const calls = Array.from({ length: 5 }, (_, index) => ({
    id: `${base.turnId}-command-${index}`, type: "commandExecution",
    command: `echo fixture-command-${index + 1}`, cwd: ".", status: "inProgress",
  }));
  for (const item of calls) notify("item/started", { ...base, item });
  await new Promise((resolve) => setTimeout(resolve, 15000));
  for (const index of [3, 1, 4, 0, 2]) {
    notify("item/completed", { ...base, item: {
      ...calls[index], status: "completed", aggregatedOutput: `Fixture result ${index + 1}`, exitCode: 0,
    } });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
