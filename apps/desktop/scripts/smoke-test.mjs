/**
 * Post-packaging smoke test for the Mcode server bundle.
 *
 * Launches server.cjs from the electron-builder unpacked directory using
 * the packaged Electron binary with ELECTRON_RUN_AS_NODE=1 (mirroring how
 * server-manager.ts spawns the server in production). Polls /health and
 * exits 0 on success, 1 on failure.
 *
 * This catches:
 * - Missing native modules (better-sqlite3, node-pty)
 * - Broken asarUnpack configuration
 * - Server startup crashes invisible in the packaged app
 * - Import/require resolution failures in the CJS bundle
 *
 * Usage:
 *   node apps/desktop/scripts/smoke-test.mjs             # auto-detect unpacked dir
 *   node apps/desktop/scripts/smoke-test.mjs --bundle    # test pre-packaging bundle (requires native deps on PATH)
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const releaseDir = resolve(desktopRoot, "release");

const SMOKE_PORT = 19899;
const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;

// ---------------------------------------------------------------------------
// Locate the unpacked server bundle and Electron binary
// ---------------------------------------------------------------------------

/** Find the server.cjs and runtime binary from the unpacked directory. */
function findUnpackedServer() {
  const candidates = [
    // Windows
    {
      server: resolve(releaseDir, "win-unpacked/resources/app.asar.unpacked/dist/server/server.cjs"),
      electron: resolve(releaseDir, "win-unpacked/Mcode.exe"),
      sqlite: resolve(releaseDir, "win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"),
    },
    // Linux (electron-builder uses productName as binary name)
    {
      server: resolve(releaseDir, "linux-unpacked/resources/app.asar.unpacked/dist/server/server.cjs"),
      electron: resolve(releaseDir, "linux-unpacked/Mcode"),
      sqlite: resolve(releaseDir, "linux-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"),
    },
    // macOS Intel
    {
      server: resolve(releaseDir, "mac/Mcode.app/Contents/Resources/app.asar.unpacked/dist/server/server.cjs"),
      electron: resolve(releaseDir, "mac/Mcode.app/Contents/MacOS/Mcode"),
      sqlite: resolve(releaseDir, "mac/Mcode.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"),
    },
    // macOS ARM
    {
      server: resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/app.asar.unpacked/dist/server/server.cjs"),
      electron: resolve(releaseDir, "mac-arm64/Mcode.app/Contents/MacOS/Mcode"),
      sqlite: resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"),
    },
  ];

  for (const c of candidates) {
    if (existsSync(c.server) && existsSync(c.electron)) {
      // Find the actual .node binding
      const electronBinding = resolve(c.sqlite, "better_sqlite3.electron.node");
      const nodeBinding = resolve(c.sqlite, "better_sqlite3.node");
      const binding = existsSync(electronBinding) ? electronBinding : existsSync(nodeBinding) ? nodeBinding : undefined;
      return { server: c.server, electron: c.electron, binding };
    }
  }
  return null;
}

/**
 * --bundle mode: test the pre-packaging bundle with the system node/bun.
 * Skips native module verification but catches JS bundle errors.
 */
function findBundleServer() {
  const server = resolve(desktopRoot, "dist/server/server.cjs");
  if (!existsSync(server)) {
    return null;
  }
  return { server, electron: process.execPath, binding: undefined };
}

const bundleOnly = process.argv.includes("--bundle");
const found = bundleOnly ? findBundleServer() : findUnpackedServer();

if (!found) {
  const target = bundleOnly ? "dist/server/server.cjs" : "unpacked release directory";
  console.error(`[smoke-test] ERROR: Could not find ${target}.`);
  console.error(bundleOnly
    ? "  Run: bun run --cwd apps/desktop build"
    : "  Run: node apps/desktop/scripts/ci-package.mjs");
  process.exit(1);
}

console.log(`[smoke-test] Server: ${found.server}`);
console.log(`[smoke-test] Runtime: ${found.electron}`);
if (found.binding) {
  console.log(`[smoke-test] SQLite binding: ${found.binding}`);
}

// ---------------------------------------------------------------------------
// Create a temporary data directory so the smoke test is isolated
// ---------------------------------------------------------------------------

const dataDir = resolve(tmpdir(), `mcode-smoke-${randomUUID().slice(0, 8)}`);
mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Spawn the server
// ---------------------------------------------------------------------------

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  MCODE_PORT: String(SMOKE_PORT),
  MCODE_DATA_DIR: dataDir,
  MCODE_MODE: "desktop",
  MCODE_VERSION: "0.0.0-smoke",
  NODE_ENV: "production",
};

if (found.binding) {
  env.BETTER_SQLITE3_BINDING = found.binding;
}

console.log(`[smoke-test] Starting server on port ${SMOKE_PORT}...`);

const child = spawn(found.electron, [
  "--max-old-space-size=96",
  found.server,
], {
  cwd: dirname(found.server),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let serverStderr = "";
child.stderr.on("data", (chunk) => { serverStderr += chunk.toString(); });
child.stdout.on("data", (chunk) => { process.stdout.write(chunk); });

// ---------------------------------------------------------------------------
// Poll /health
// ---------------------------------------------------------------------------

let exited = false;
/** Resolves when the child process exits. */
const exitPromise = new Promise((resolve) => {
  child.on("exit", (code) => {
    exited = true;
    if (code !== null && code !== 0) {
      console.error(`[smoke-test] Server exited with code ${code}`);
      if (serverStderr) {
        console.error("[smoke-test] stderr:\n" + serverStderr.slice(-2000));
      }
    }
    resolve(code);
  });
});

const deadline = Date.now() + TIMEOUT_MS;
let healthy = false;

while (Date.now() < deadline && !exited) {
  try {
    const res = await fetch(`http://localhost:${SMOKE_PORT}/health`);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    // not ready yet
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

// ---------------------------------------------------------------------------
// Report and cleanup
// ---------------------------------------------------------------------------

// Kill the server (graceful then force)
try { process.kill(child.pid, "SIGTERM"); } catch { /* already dead */ }
setTimeout(() => {
  try { process.kill(child.pid, "SIGKILL"); } catch { /* ok */ }
}, 3000);

// Wait for exit
await exitPromise;

// Clean up temp data directory
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }

if (healthy) {
  console.log("[smoke-test] PASS: Server started and /health returned 200.");
  process.exit(0);
} else if (exited) {
  console.error("[smoke-test] FAIL: Server crashed before becoming ready.");
  if (serverStderr) {
    console.error("[smoke-test] Last stderr output:\n" + serverStderr.slice(-2000));
  }
  process.exit(1);
} else {
  console.error(`[smoke-test] FAIL: Server did not respond within ${TIMEOUT_MS / 1000}s.`);
  if (serverStderr) {
    console.error("[smoke-test] Last stderr output:\n" + serverStderr.slice(-2000));
  }
  process.exit(1);
}
