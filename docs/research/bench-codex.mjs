// Benchmark: codex app-server handshake + per-turn TTFT/token attribution.
// Mirrors Mcode's flow: spawn -> initialize -> initialized -> thread/start -> turn/start(s).
// Usage: node .dev/bench-codex.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const isWin = process.platform === "win32";
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startAppServer() {
  const t0 = now();
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: isWin,
    cwd: process.cwd(),
  });
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const serverRequests = [];

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve({ msg, at: now() }); }
    } else if (msg.id !== undefined && msg.method) {
      serverRequests.push({ at: now(), method: msg.method, id: msg.id });
    } else if (msg.method) {
      notifications.push({ at: now(), method: msg.method, params: msg.params });
    }
  });
  child.stderr.on("data", () => {});
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 180_000);
    });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, send, notify, notifications, serverRequests, spawnedAt: t0 };
}

async function handshake(srv, label) {
  const t = { label, spawnAt: srv.spawnedAt };
  const init = await srv.send("initialize", {
    clientInfo: { name: "mcode-bench", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  t.initializeMs = init.at - srv.spawnedAt;
  srv.notify("initialized", {});
  const th = await srv.send("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  t.threadStartMs = th.at - init.at;
  t.threadId = th.msg.result?.thread?.id ?? th.msg.result?.threadId;
  return t;
}

async function runTurn(srv, threadId, prompt, opts = {}) {
  const mark = srv.notifications.length;
  const tSend = now();
  await srv.send("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
  });
  // wait for turn/completed
  let firstDeltaAt = null, completedAt = null, usage = null, firstMethod = null;
  const deadline = now() + 300_000;
  while (now() < deadline) {
    for (const n of srv.notifications.slice(mark)) {
      if (!firstDeltaAt && (n.method === "item/agentMessage/delta" || n.method === "item/started")) {
        firstDeltaAt = n.at; firstMethod = n.method;
      }
      if (n.method === "thread/tokenUsage/updated") usage = n.params?.tokenUsage ?? usage;
      if (n.method === "turn/completed") completedAt = n.at;
    }
    if (completedAt) break;
    await sleep(50);
  }
  return {
    label: opts.label, effort: opts.effort ?? "default", serviceTier: opts.serviceTier ?? "default",
    ttftMs: firstDeltaAt ? firstDeltaAt - tSend : null, firstMethod,
    totalMs: completedAt ? completedAt - tSend : null,
    lastInput: usage?.last?.inputTokens ?? null,
    lastCached: usage?.last?.cachedInputTokens ?? null,
    lastOutput: usage?.last?.outputTokens ?? null,
    lastReasoning: usage?.last?.reasoningOutputTokens ?? null,
    totalInput: usage?.total?.inputTokens ?? null,
    totalOutput: usage?.total?.outputTokens ?? null,
  };
}

const results = { startedAt: new Date().toISOString(), phases: [], turns: [], serverRequests: [] };

// Scenario 1: cold process, thread A, effort high, 4 turns (A2/A3 grow context)
const srv = startAppServer();
const hs = await handshake(srv, "cold-spawn-A");
results.phases.push(hs);
console.log(`handshake: initialize=${hs.initializeMs}ms thread/start=${hs.threadStartMs}ms thread=${hs.threadId}`);

const SHORT = "Reply with exactly the text: OK";
const GROW1 = "Write about 400 words on the history of the printing press. Plain prose, no lists.";
const GROW2 = "Write about 400 words on the history of the steam engine. Plain prose, no lists.";

for (const [label, prompt, opts] of [
  ["A1-high-short", SHORT, { effort: "high" }],
  ["A2-high-grow", GROW1, { effort: "high" }],
  ["A3-high-grow", GROW2, { effort: "high" }],
  ["A4-high-short-grown", SHORT, { effort: "high" }],
]) {
  const r = await runTurn(srv, hs.threadId, prompt, { ...opts, label });
  results.turns.push(r);
  console.log(`${label}: ttft=${r.ttftMs}ms total=${r.totalMs}ms in=${r.lastInput} cached=${r.lastCached} out=${r.lastOutput} reasoning=${r.lastReasoning}`);
}

// Scenario 2/3/4: fresh threads, identical short prompt, effort low / medium / high+priority
for (const [label, opts] of [
  ["B-low", { effort: "low" }],
  ["C-medium", { effort: "medium" }],
  ["D-high-priority", { effort: "high", serviceTier: "priority" }],
]) {
  const th = await srv.send("thread/start", {
    cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only",
  });
  const tid = th.msg.result?.thread?.id ?? th.msg.result?.threadId;
  const r = await runTurn(srv, tid, SHORT, { ...opts, label });
  results.turns.push(r);
  console.log(`${label}: ttft=${r.ttftMs}ms total=${r.totalMs}ms in=${r.lastInput} cached=${r.lastCached} out=${r.lastOutput} reasoning=${r.lastReasoning}`);
}

srv.child.kill();

// Warm handshake: second spawn, initialize only
const srv2 = startAppServer();
const hs2 = await handshake(srv2, "warm-spawn");
results.phases.push(hs2);
console.log(`warm handshake: initialize=${hs2.initializeMs}ms thread/start=${hs2.threadStartMs}ms`);
srv2.child.kill();

results.serverRequests = srv.serverRequests;
writeFileSync(".dev/bench-codex-results.json", JSON.stringify(results, null, 2));
console.log("wrote .dev/bench-codex-results.json");
process.exit(0);
