// Rep pass: fresh threads, identical short prompt, vary effort/tier. n=2 each.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const isWin = process.platform === "win32";
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startAppServer() {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], shell: isWin, cwd: process.cwd() });
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p.resolve({ msg, at: now() }); }
    } else if (msg.method) notifications.push({ at: now(), method: msg.method, params: msg.params });
  });
  child.stderr.on("data", () => {});
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 180_000);
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, send, notify, notifications };
}

async function runTurn(srv, threadId, prompt, opts) {
  const mark = srv.notifications.length;
  const tSend = now();
  await srv.send("turn/start", {
    threadId, input: [{ type: "text", text: prompt }],
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
  });
  let firstDeltaAt = null, completedAt = null, usage = null;
  const deadline = now() + 300_000;
  while (now() < deadline) {
    for (const n of srv.notifications.slice(mark)) {
      if (!firstDeltaAt && (n.method === "item/agentMessage/delta" || n.method === "item/started")) firstDeltaAt = n.at;
      if (n.method === "thread/tokenUsage/updated") usage = n.params?.tokenUsage ?? usage;
      if (n.method === "turn/completed") completedAt = n.at;
    }
    if (completedAt) break;
    await sleep(50);
  }
  return { ...opts, ttftMs: firstDeltaAt ? firstDeltaAt - tSend : null, totalMs: completedAt ? completedAt - tSend : null,
    lastInput: usage?.last?.inputTokens ?? null, lastCached: usage?.last?.cachedInputTokens ?? null,
    lastOutput: usage?.last?.outputTokens ?? null, lastReasoning: usage?.last?.reasoningOutputTokens ?? null };
}

const srv = startAppServer();
await srv.send("initialize", { clientInfo: { name: "mcode-bench", version: "1.0.0" }, capabilities: { experimentalApi: true } });
srv.notify("initialized", {});

const SHORT = "Reply with exactly the text: OK";
const variants = [
  ["high", undefined], ["high", undefined],
  ["low", undefined], ["low", undefined],
  ["medium", undefined], ["medium", undefined],
  ["high", "priority"], ["high", "priority"],
  ["minimal", undefined], ["none", undefined],
];
const rows = [];
for (const [effort, serviceTier] of variants) {
  const th = await srv.send("thread/start", { cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only" });
  const tid = th.msg.result?.thread?.id ?? th.msg.result?.threadId;
  const r = await runTurn(srv, tid, SHORT, { effort, serviceTier });
  rows.push(r);
  console.log(`${effort}/${serviceTier ?? "default"}: ttft=${r.ttftMs}ms total=${r.totalMs}ms in=${r.lastInput} cached=${r.lastCached} reasoning=${r.lastReasoning}`);
}
srv.child.kill();
writeFileSync(".dev/bench-codex-reps.json", JSON.stringify(rows, null, 2));
console.log("wrote .dev/bench-codex-reps.json");
process.exit(0);
