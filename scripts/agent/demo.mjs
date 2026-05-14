#!/usr/bin/env node
/**
 * Boots `bun run dev:web` (if not already running), polls the Vite dev URL
 * until it responds, then prints the URL plus a copy-pasteable Playwright MCP
 * entry point so an agent can immediately drive the app.
 *
 * Intended to be invoked by the /demo slash command (Claude) or directly by
 * any agent harness (`node scripts/agent/demo.mjs`).
 *
 * Exits 0 once the server is reachable, 1 on timeout.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DEV_URL = process.env.MCODE_DEMO_URL ?? "http://127.0.0.1:5173";
const TIMEOUT_MS = Number(process.env.MCODE_DEMO_TIMEOUT_MS ?? 60_000);
const POLL_INTERVAL_MS = 1_000;
const SCREENSHOT_DIR = join("apps", "web", "e2e", "screenshots", "demo");

/**
 * Ping the dev server. Resolves true if it returns any HTTP status.
 */
async function isReachable(url) {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`[demo] target: ${DEV_URL}`);

  const alreadyUp = await isReachable(DEV_URL);
  let child = null;
  if (alreadyUp) {
    console.log("[demo] dev server already reachable — skipping spawn");
  } else {
    console.log("[demo] starting `bun run dev:web` in the background…");
    child = spawn("bun", ["run", "dev:web"], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.unref();
  }

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (await isReachable(DEV_URL)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      console.log("");
      console.log(`[demo] ready: ${DEV_URL}`);
      console.log(`[demo] screenshots dir: ${SCREENSHOT_DIR}`);
      console.log("");
      console.log("[demo] Drive it via the Playwright MCP:");
      console.log(`  mcp__playwright__browser_navigate({ url: "${DEV_URL}" })`);
      console.log("  mcp__playwright__browser_snapshot()");
      console.log(
        `  mcp__playwright__browser_take_screenshot({ filename: "${SCREENSHOT_DIR}/<step>.png" })`,
      );
      console.log("  mcp__playwright__browser_console_messages()");
      process.exit(0);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.error(
    `[demo] timed out after ${TIMEOUT_MS}ms waiting for ${DEV_URL}`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[demo] failed:", err);
  process.exit(1);
});
