#!/usr/bin/env bun
/** Seeds synthetic transcript history through the owned Electron server. */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assertInsideDevDir, getRuntimePaths, resolveRepoRoot } from "../../../../scripts/agent/runtime-contract.mjs";
import { openDesktopSocket, findFixtureWorkspace } from "./thread-lifecycle.mjs";
import { renderFixtureWrapper } from "./codex-protocol-notices.mjs";

const HELP = `Seed a synthetic transcript in the owned Electron runtime

Usage:
  bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop transcript seed [turn-count] [runtime-directory]

Defaults: 13 turns, .dev/electron-live-testing/runtime.
The last turn contains 120 reasoning/tool pairs; earlier turns contain three pairs.
Each run creates a new direct thread in .dev/fixture-repo. No model service is called.
Run only in an idle verification runtime. The previous Codex CLI setting is restored.
The receipt stays in .dev/verification/transcript-seed/<run-id>/receipt.json.
If the process is forcibly stopped, restore originalCli from that receipt before use.
No database is copied, cleared, or replaced.`;

async function main() {
  const [command, countText = "13", runtime = ".dev/electron-live-testing/runtime", ...extra] = process.argv.slice(2);
  if ([undefined, "--help", "-h"].includes(command)) return console.log(HELP);
  const count = Number(countText);
  if (command !== "seed" || extra.length || !Number.isInteger(count) || count < 1 || count > 40) {
    throw new Error("Use seed with a turn count from 1 to 40 and an optional runtime directory");
  }
  const root = resolveRepoRoot();
  const runtimeDirectory = NodePath.resolve(root, runtime);
  assertInsideDevDir(runtimeDirectory, getRuntimePaths(root).devDir);
  await assertIdle(runtimeDirectory);
  const socket = await openDesktopSocket(root, runtimeDirectory);
  try {
    await seed(socket, root, count);
  } finally {
    await socket.close();
  }
}

async function assertIdle(runtimeDirectory) {
  const lock = JSON.parse(NodeFS.readFileSync(NodePath.join(runtimeDirectory, "server.lock"), "utf8"));
  if (!Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535) throw new Error("Invalid owned runtime port");
  const response = await fetch(`http://127.0.0.1:${lock.port}/health`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok || (await response.json()).activeAgents !== 0) {
    throw new Error("The verification runtime must be healthy with zero active agents");
  }
}

async function seed(socket, root, count) {
  const workspace = await findFixtureWorkspace(socket, getRuntimePaths(root).fixtureRepoDir);
  const branch = NodeChildProcess.execFileSync("git", ["branch", "--show-current"], { cwd: workspace.path, encoding: "utf8", windowsHide: true }).trim();
  if (!branch) throw new Error("The fixture repository must have a checked-out branch");
  const originalCli = (await socket.rpc("settings.get", {})).provider.cli.codex;
  const runId = NodeCrypto.randomUUID();
  const directory = NodePath.join(root, ".dev", "verification", "transcript-seed", runId);
  assertInsideDevDir(directory, getRuntimePaths(root).devDir);
  NodeFS.mkdirSync(directory, { recursive: true });
  const cliPath = NodePath.join(directory, "provider.cmd");
  NodeFS.writeFileSync(cliPath, renderFixtureWrapper(process.execPath, NodePath.join(import.meta.dirname, "transcript-provider-fixture.mjs")), { flag: "wx" });
  const receiptPath = NodePath.join(directory, "receipt.json");
  const receipt = { runId, originalCli, title: `Transcript seed ${runId}`, threadId: null, completedTurns: 0, restoredCli: false };
  const save = () => NodeFS.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  save();
  try {
    await socket.rpc("settings.update", { provider: { cli: { codex: cliPath } } });
    const thread = await socket.rpc("thread.create", { workspaceId: workspace.id, title: receipt.title, mode: "direct", branch });
    receipt.threadId = thread.id;
    save();
    console.log(JSON.stringify({ threadId: thread.id, title: receipt.title, receiptPath }));
    for (let index = 0; index < count; index += 1) {
      await seedTurn(socket, workspace.id, thread.id, index, count);
      receipt.completedTurns = index + 1;
      save();
    }
  } finally {
    await socket.rpc("settings.update", { provider: { cli: { codex: originalCli } } });
    receipt.restoredCli = true;
    save();
  }
  console.log(JSON.stringify({ ok: true, completedTurns: receipt.completedTurns, restoredCli: receipt.restoredCli, receiptPath }));
}

async function seedTurn(socket, workspaceId, threadId, index, count) {
  await socket.rpc("agent.send", {
    threadId, content: `Transcript fixture request ${index + 1}${index === count - 1 ? ": long narrative" : ""}`,
    messageId: NodeCrypto.randomUUID(), provider: "codex", model: "gpt-5.6-luna", permissionMode: "full",
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const threads = await socket.rpc("thread.list", { workspaceId });
    if (threads.find((thread) => thread.id === threadId)?.status === "completed") {
      const page = await socket.rpc("message.list", { threadId, limit: 1000 });
      const answers = page.messages.filter((message) => message.role === "assistant");
      if (answers.length === index + 1 && answers.every((message) => message.content.startsWith("Fixture answer:"))) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Fixture turn ${index + 1} did not complete; inspect the receipt and owned thread`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
