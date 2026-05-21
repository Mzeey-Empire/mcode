/**
 * Dev orchestration script for the Electron desktop app.
 *
 * 1. Starts the web (renderer) dev server and esbuild in parallel.
 * 2. Compiles the backend server (`tsc` → `esbuild`, same pipeline as packaged
 *    builds) so the desktop child runs `server.cjs` without `--import tsx`.
 * 3. Detects the actual Vite dev server URL (auto-increments port if taken).
 * 4. Spawns Electron with ELECTRON_RENDERER_URL pointing at the dev server.
 * 5. Restarts Electron when dist/main/main.cjs or dist/server/server.cjs
 *    changes (debounced 300ms).
 * 6. Cleans up all child processes on SIGINT/SIGTERM.
 */

import { context, build } from "esbuild";
import { execSync, spawn } from "child_process";
import { watch } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  rebuildServerDevBundle,
  resolveServerTscBin,
  copyClaudeSdkCliNextTo,
} from "../../../scripts/build-server-dev-bundle.mjs";

const isWindows = process.platform === "win32";

/**
 * Kill a process and its entire child tree.
 *
 * On Windows, `ChildProcess.kill()` only terminates the immediate process.
 * When `shell: true` is used (required for spawning .exe under Git Bash),
 * the actual application runs as a child of `cmd.exe`. Killing `cmd.exe`
 * leaves the real process as an orphan. `taskkill /T /F` walks the tree.
 *
 * On POSIX, `process.kill(-pid)` sends the signal to the process group.
 */
function killProcessTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (isWindows) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", timeout: 5000 });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // Process already exited or PID invalid
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const webRoot = resolve(projectRoot, "..", "web");
const serverRoot = resolve(projectRoot, "..", "server");

/** Paths to Electron main/preload bundles and server bundle (restart triggers). */
const mainOutFile = resolve(projectRoot, "dist/main/main.cjs");
const preloadOutFile = resolve(projectRoot, "dist/preload/preload.cjs");
const serverOutFile = resolve(projectRoot, "dist/server/server.cjs");

/** Shared esbuild options. */
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  format: "cjs",
};

/**
 * Spawn `tsc --watch` so server source edits re-emit apps/server/dist-tsc.
 *
 * @param {(() => void) | undefined} onReady Called once after the initial
 *   compilation completes (detected by "Watching for file changes" output).
 *   Use this to defer side-effects that should not fire during the initial
 *   (redundant) compilation pass.
 * @returns Detached subprocess handle (caller must `.kill()` on shutdown).
 */
function startServerTscWatch(onReady) {
  const tscBin = resolveServerTscBin(serverRoot);
  const child = spawn(process.execPath, [
    tscBin,
    "--project",
    resolve(serverRoot, "tsconfig.build.json"),
    "--watch",
    "--preserveWatchOutput",
  ], {
    cwd: serverRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let initialReady = false;
  function handleOutput(data) {
    const text = data.toString();
    process.stdout.write(text);
    if (!initialReady) {
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      if (clean.includes("Watching for file changes")) {
        initialReady = true;
        onReady?.();
      }
    }
  }

  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);
  return child;
}

/** esbuild entry point configs. */
const entries = [
  {
    ...shared,
    entryPoints: [resolve(projectRoot, "src/main/main.ts")],
    outfile: mainOutFile,
    external: ["electron"],
  },
  {
    ...shared,
    entryPoints: [resolve(projectRoot, "src/main/preload.ts")],
    outfile: resolve(projectRoot, "dist/preload/preload.cjs"),
    external: ["electron"],
  },
];

console.log("[dev] Building bundled server entry (apps/desktop/dist/server/server.cjs)...");
await rebuildServerDevBundle();

/**
 * Must run before server `esbuild` watch so `dist-tsc` emits complete graphs
 * per save. The `onReady` callback defers `distTscWatcher` creation until
 * after tsc's initial compilation finishes, preventing the redundant
 * dist-tsc → esbuild → server.cjs cascade from restarting Electron on startup.
 */
let serverTscWatch = startServerTscWatch(() => {
  startDistTscWatcher();
});

/** Safety net: if tsc --watch never reports ready within 120s, start the watcher anyway. */
const tscReadyTimeout = setTimeout(() => {
  if (!distTscWatcher) {
    console.warn("[dev] tsc --watch did not report ready within 120s; starting dist-tsc watcher anyway");
    startDistTscWatcher();
  }
}, 120_000);

const serverEsbuildCfg = {
  ...shared,
  entryPoints: [resolve(serverRoot, "dist-tsc/index.js")],
  outfile: serverOutFile,
  external: ["better-sqlite3", "node-pty", "electron", "koffi"],
  banner: {
    js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    "import.meta.url": "__importMetaUrl",
    // Do not bake NODE_ENV — the server child inherits Electron's runtime env.
  },
};

/** esbuild `watch` races `tsc --watch` when it rebuilds after the first changed file; debounce bundling. */
let serverBundleRebuildTimer = null;
let distTscWatcher = null;

/** Idempotent: creates the dist-tsc watcher if it doesn't already exist. */
function startDistTscWatcher() {
  if (distTscWatcher) return;
  try {
    distTscWatcher = watch(resolve(serverRoot, "dist-tsc"), { recursive: true }, () => {
      scheduleServerBundleRebuild();
    });
    console.log("[dev] dist-tsc watcher started (server hot-rebuild enabled)");
  } catch (err) {
    console.warn("[dev] Could not watch apps/server/dist-tsc; server hot-rebuild disabled:", err);
  }
}

function scheduleServerBundleRebuild() {
  if (serverBundleRebuildTimer) clearTimeout(serverBundleRebuildTimer);
  serverBundleRebuildTimer = setTimeout(async () => {
    serverBundleRebuildTimer = null;
    try {
      await build({ ...serverEsbuildCfg });
      copyClaudeSdkCliNextTo(serverOutFile, serverRoot);
    } catch (err) {
      console.error("[dev] server bundle rebuild failed:", err);
    }
  }, 300);
}

// -------------------------------------------------------------------------
// Step 1: Start web dev server + esbuild in parallel
// -------------------------------------------------------------------------

let viteProcess = null;

/** True while `cleanup()` is tearing children down so Vite exit is not treated as a crash. */
let devSessionShuttingDown = false;

/**
 * Start the Vite dev server. Returns a promise that resolves with the
 * actual URL once Vite prints its "Local:" line (checks both stdout and
 * stderr since Vite's output stream varies by version).
 */
function startViteDevServer() {
  return new Promise((resolveUrl) => {
    let bootstrapResolved = false;

    function tryParseUrl(text) {
      if (bootstrapResolved) return;
      // Strip ANSI escape codes - Vite injects bold/color mid-token
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      const match = clean.match(/Local:\s+(https?:\/\/\S+)/);
      if (match) {
        bootstrapResolved = true;
        resolveUrl(match[1].replace(/\/+$/, ""));
      }
    }

    viteProcess = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "development" },
    });

    viteProcess.stdout.on("data", (data) => {
      const text = data.toString();
      process.stdout.write(`[web] ${text}`);
      tryParseUrl(text);
    });

    viteProcess.stderr.on("data", (data) => {
      const text = data.toString();
      process.stderr.write(`[web] ${text}`);
      tryParseUrl(text);
    });

    viteProcess.on("exit", (code) => {
      if (!bootstrapResolved) {
        bootstrapResolved = true;
        resolveUrl(null);
      }
      console.error(`[web] Vite dev server exited with code ${code}`);

      if (devSessionShuttingDown) return;

      if (electronProcess) {
        console.error(
          "[dev] The renderer loads modules from Vite; with the dev server gone the window " +
            "will show ERR_CONNECTION_REFUSED and failed dynamic imports. Stopping Electron.",
        );
        cleanup();
        process.exit(code ?? 1);
      }
    });
  });
}

// Run Vite startup and esbuild (main/preload) watch in parallel
const [devServerUrl, watchContexts] = await Promise.all([
  startViteDevServer(),
  Promise.all(
    entries.map(async (cfg) => {
      const ctx = await context(cfg);
      await ctx.rebuild();
      await ctx.watch();
      return ctx;
    }),
  ),
]);

if (!devServerUrl) {
  console.error("[dev] Vite dev server failed to start");
  process.exit(1);
}

console.log("[dev] Initial build complete, watching for changes...");
console.log(`[dev] Web dev server is ready at ${devServerUrl}`);

// -------------------------------------------------------------------------
// Step 2: Spawn Electron
// -------------------------------------------------------------------------

let electronProcess = null;

/** Spawn (or restart) the Electron process. */
function spawnElectron() {
  if (electronProcess) {
    killProcessTree(electronProcess);
    electronProcess = null;
  }

  // Resolve the local Electron binary from the project's node_modules.
  // Using npx/bunx can pick up a globally installed Electron with a
  // different Node.js ABI, causing native module load failures (e.g.
  // better-sqlite3 compiled for ABI 133 but global Electron needs 145).
  //
  // shell: true routes through cmd.exe on Windows, avoiding the EFTYPE
  // error that occurs when spawning .exe files directly under Git Bash.
  //
  // ELECTRON_RUN_AS_NODE must be removed from the env. When dev:desktop is
  // launched from terminals running inside Electron-based apps (e.g. Claude
  // Code, VS Code), this flag is inherited and forces Electron to run as
  // plain Node.js, making the `electron` module API unavailable.
  const desktopRequire = createRequire(resolve(projectRoot, "package.json"));
  const electronBin = desktopRequire("electron");
  const electronEnv = {
    ...process.env,
    ELECTRON_RENDERER_URL: devServerUrl,
    NODE_ENV: "development",
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  // Remove inherited MCODE_DATA_DIR so the dev instance falls back to
  // ~/.mcode-dev, isolating dev data from the production directory.
  delete electronEnv.MCODE_DATA_DIR;
  electronProcess = spawn(electronBin, ["."], {
    cwd: projectRoot,
    stdio: "inherit",
    env: electronEnv,
    shell: true,
  });

  electronProcess.on("exit", (code) => {
    // If Electron exits on its own (user closed window), shut down dev script
    if (electronProcess) {
      electronProcess = null;
      cleanup();
      process.exit(code ?? 0);
    }
  });
}

spawnElectron();

// -------------------------------------------------------------------------
// Step 3: Restart Electron on main/server bundle rebuild (debounced)
// -------------------------------------------------------------------------

let debounceTimer = null;

/**
 * Debounce Electron restart so rapid esbuild increments coalesce.
 *
 * @param {string} reason Log line fragment after `[dev]`.
 */
function scheduleElectronRestart(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`[dev] ${reason}, restarting Electron...`);
    spawnElectron();
  }, 300);
}

watch(mainOutFile, () => scheduleElectronRestart("main bundle updated"));
watch(preloadOutFile, () => scheduleElectronRestart("preload bundle updated"));
watch(serverOutFile, () => scheduleElectronRestart("server bundle updated"));

// -------------------------------------------------------------------------
// Step 4: Cleanup on exit signals
// -------------------------------------------------------------------------

/** Stop all child processes and esbuild watchers. */
function cleanup() {
  devSessionShuttingDown = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  if (serverBundleRebuildTimer) {
    clearTimeout(serverBundleRebuildTimer);
    serverBundleRebuildTimer = null;
  }

  clearTimeout(tscReadyTimeout);

  if (distTscWatcher) {
    try {
      distTscWatcher.close();
    } catch {
      /* ignore */
    }
    distTscWatcher = null;
  }

  if (serverTscWatch) {
    killProcessTree(serverTscWatch);
    serverTscWatch = null;
  }

  for (const ctx of watchContexts) {
    ctx.dispose().catch(() => {});
  }

  if (electronProcess) {
    killProcessTree(electronProcess);
    electronProcess = null;
  }

  if (viteProcess) {
    killProcessTree(viteProcess);
    viteProcess = null;
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
