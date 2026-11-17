/**
 * One-shot dev server bundle: `apps/server` swc emit (decorator metadata for
 * tsyringe) followed by esbuild CJS bundle to `apps/desktop/dist/server/server.cjs`,
 * plus Copilot SDK native CLI binaries beside it. Shared by desktop dev orchestration
 * and `scripts/dev-web.mjs` (no `--import tsx` at runtime). Typechecking is NOT
 * part of this pipeline — it lives in the separate `typecheck` verify gate
 * (and `tsc --watch` during `dev:desktop` for live feedback).
 */

import { build } from "esbuild";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

// bun build --compile keeps build-machine paths, so packaged bundles use the resources root passed by the desktop.
const importMetaUrlBanner = [
  "var __importMetaPath = __filename;",
  "if (process.env.MCODE_PACKAGED_RESOURCES_ROOT) {",
  '  __importMetaPath = require("path").join(',
  "    process.env.MCODE_PACKAGED_RESOURCES_ROOT,",
  '    "app.asar.unpacked",',
  '    "dist",',
  '    "server",',
  '    require("path").basename(__filename),',
  "  );",
  "}",
  'var __importMetaUrl = require("url").pathToFileURL(__importMetaPath).href;',
].join("\n");

/** Monorepo root when this script lives at `<root>/scripts/`. */
export function repoRootFromScript() {
  return NodePath.resolve(__dirname, "..");
}

/**
 * Resolve the bundled `typescript` compiler entry for `execFile(process.execPath, [...])`.
 *
 * @param serverRoot Usually `apps/server` (passed so worktrees/monorepo roots resolve reliably).
 */
export function resolveServerTscBin(serverRoot = NodePath.resolve(repoRootFromScript(), "apps/server")) {
  const localTsc = NodePath.resolve(serverRoot, "node_modules/typescript/bin/tsc");
  const rootTsc = NodePath.resolve(serverRoot, "../../node_modules/typescript/bin/tsc");
  return NodeFS.existsSync(localTsc) ? localTsc : rootTsc;
}

/**
 * Compile apps/server → dist-tsc via swc (`.swcrc` carries `decoratorMetadata`,
 * matching tsc's `emitDecoratorMetadata` for tsyringe DI). ~50x faster than the
 * tsc emit (sub-second vs ~20s cold) because swc strips types without checking
 * them — typechecking remains the job of the separate `typecheck` verify gate.
 *
 * The output dir stays `dist-tsc` so esbuild call sites need no path changes.
 * The dir is wiped first: swc is fast enough that incrementality buys nothing,
 * and a clean emit prevents stale files from a previous tsc run lingering.
 *
 * @param {string} [serverRoot] Root of `apps/server` (directory with `package.json`).
 */
export function compileServerWithSwc(serverRoot = NodePath.resolve(repoRootFromScript(), "apps/server")) {
  const serverRequire = NodeModule.createRequire(NodePath.resolve(serverRoot, "package.json"));
  const swcBin = serverRequire.resolve("@swc/cli/bin/swc.js");
  const outDir = NodePath.resolve(serverRoot, "dist-tsc");
  if (NodeFS.existsSync(outDir)) NodeFS.rmSync(outDir, { recursive: true, force: true });
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      swcBin,
      "src",
      "-d",
      "dist-tsc",
      "--config-file",
      NodePath.resolve(serverRoot, ".swcrc"),
      "--strip-leading-paths",
      // Compile in-process instead of via a piscina worker pool: worker
      // threads hit "Not implemented" under the bun version pinned for CI,
      // and at ~140 files the pool saves nothing anyway.
      "--sync",
    ],
    { cwd: serverRoot, stdio: "inherit" },
  );
}

/**
 * Map electron-builder platform names to npm `process.platform` values.
 *
 * @param {string} electronPlatformName
 * @returns {NodeJS.Platform}
 */
export function electronPlatformToNpm(electronPlatformName) {
  if (electronPlatformName === "win32") return "win32";
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") return "darwin";
  if (electronPlatformName === "linux") return "linux";
  throw new Error(`Unsupported electron platform: ${electronPlatformName}`);
}

/**
 * Map electron-builder `Arch` values (string or numeric enum) to npm `process.arch`.
 *
 * @param {string | number} electronArch
 * @returns {NodeJS.Architecture}
 */
export function electronArchToNpm(electronArch) {
  if (typeof electronArch === "string") {
    if (electronArch === "armv7l") return "arm";
    return /** @type {NodeJS.Architecture} */ (electronArch);
  }
  switch (electronArch) {
    case 0:
      return "ia32";
    case 1:
      return "x64";
    case 2:
      return "arm";
    case 3:
      return "arm64";
    case 4:
      throw new Error("electron-builder Arch.universal is not supported for SDK platform packages");
    default:
      throw new Error(`Unsupported electron-builder arch: ${electronArch}`);
  }
}

/**
 * Resolve the on-disk `dist/server` directory inside a packaged app.
 *
 * @param {object} args
 * @param {string} args.appOutDir electron-builder output directory (e.g. `win-unpacked`).
 * @param {string} args.electronPlatformName
 * @param {string} args.productFilename App binary filename without extension.
 */
export function resolvePackagedServerDir({ appOutDir, electronPlatformName, productFilename }) {
  const tail = ["app.asar.unpacked", "dist", "server"];
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    return NodePath.resolve(appOutDir, `${productFilename}.app`, "Contents", "Resources", ...tail);
  }
  return NodePath.resolve(appOutDir, "resources", ...tail);
}

/** Return the platform-specific optional package name shipped with Copilot CLI. */
export function copilotSdkPlatformPackageName(platform, arch) {
  return `@github/copilot-${platform}-${arch}`;
}

/**
 * Resolve the Copilot SDK package and its bundled CLI dependencies from the SDK's own
 * dependency graph. This avoids relying on the workspace's hoisted or global packages.
 */
export function resolveCopilotSdkSources(serverPackageRoot, platform, arch) {
  const platformPkg = copilotSdkPlatformPackageName(platform, arch);
  const binName = platform === "win32" ? "copilot.exe" : "copilot";
  try {
    const serverRequire = NodeModule.createRequire(NodePath.resolve(serverPackageRoot, "package.json"));
    const providerRequire = NodeModule.createRequire(serverRequire.resolve("@mcode/providers"));
    const sdkEntry = providerRequire.resolve("@github/copilot-sdk");
    const sdkRequire = NodeModule.createRequire(sdkEntry);
    const copilotPackageDir = NodeFS.realpathSync(NodePath.resolve(NodePath.dirname(sdkEntry), "..", "..", "..", "copilot"));
    const platformPackageDir = resolveCopilotSdkPlatformPackageDir(
      sdkRequire,
      sdkEntry,
      platformPkg,
      binName,
    );
    return { platformPkg, copilotPackageDir, platformPackageDir };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${platformPkg} not installed - run 'bun install' or node apps/desktop/scripts/desktop-packaging/target-package/target-package.mjs (Copilot SDK dependencies are out of sync): ${detail}`,
    );
  }
}

function resolveCopilotSdkPlatformPackageDir(sdkRequire, sdkEntry, platformPkg, binName) {
  try {
    return NodeFS.realpathSync(NodePath.dirname(sdkRequire.resolve(platformPkg)));
  } catch (error) {
    // Cross-target packages live in Bun's isolated store, but the host resolver can reject their export.
    const packageDir = NodePath.resolve(resolveSdkStoreRoot(sdkEntry), platformPkg);
    if (
      NodeFS.existsSync(NodePath.join(packageDir, "package.json"))
      && NodeFS.existsSync(NodePath.join(packageDir, binName))
    ) {
      return NodeFS.realpathSync(packageDir);
    }
    throw error;
  }
}

function resolveSdkStoreRoot(sdkEntry) {
  let current = NodePath.resolve(sdkEntry);
  while (current !== NodePath.dirname(current)) {
    if (NodePath.basename(current) === "node_modules") return current;
    current = NodePath.dirname(current);
  }
  throw new Error(`Cannot locate the SDK package store for ${sdkEntry}`);
}

/** Compare two complete package trees without mutating either destination. */
function copilotTreesMatch(sourceDir, destinationDir, skipDanglingOptional = true) {
  const destinationDirectory = inspectDestinationDirectory(destinationDir);
  if (destinationDirectory === "unreadable") return true;
  if (destinationDirectory === "missing") return false;
  const sourceEntries = copilotSourceEntries(sourceDir, skipDanglingOptional);
  const destinationEntries = readDestinationEntries(destinationDir);
  if (destinationEntries === "unreadable") return true;
  if (sourceEntries.length !== destinationEntries.length) return false;

  const destinationByName = new Map(destinationEntries.map((entry) => [entry.name, entry]));
  for (const sourceEntry of sourceEntries) {
    const entryMatches = copilotEntryMatches(
      sourceDir,
      destinationDir,
      sourceEntry,
      destinationByName,
      skipDanglingOptional,
    );
    if (entryMatches !== true) return entryMatches === "unreadable";
  }
  return true;
}

function inspectDestinationDirectory(destinationDir) {
  try {
    return NodeFS.statSync(destinationDir).isDirectory() ? "readable" : "missing";
  } catch (error) {
    return isDestinationAccessError(error) ? "unreadable" : "missing";
  }
}

function readDestinationEntries(destinationDir) {
  try {
    return NodeFS.readdirSync(destinationDir, { withFileTypes: true });
  } catch (error) {
    if (isDestinationAccessError(error)) return "unreadable";
    throw error;
  }
}

function copilotEntryMatches(sourceDir, destinationDir, sourceEntry, destinationByName, skipDanglingOptional) {
  if (!destinationByName.has(sourceEntry.name)) return false;
  const sourcePath = NodePath.resolve(sourceDir, sourceEntry.name);
  const destinationPath = NodePath.resolve(destinationDir, sourceEntry.name);
  const destinationKind = readDestinationKind(destinationPath);
  if (destinationKind === "unreadable") return destinationKind;
  if (sourceEntry.kind !== destinationKind) return false;
  if (sourceEntry.kind === "directory") {
    return copilotTreesMatch(sourcePath, destinationPath, skipDanglingOptional);
  }
  return copilotFilesMatchOrAccessState(sourcePath, destinationPath);
}

function readDestinationKind(destinationPath) {
  try {
    const stat = NodeFS.lstatSync(destinationPath);
    if (stat.isDirectory()) return "directory";
    return stat.isFile() ? "file" : null;
  } catch (error) {
    if (isDestinationAccessError(error)) return "unreadable";
    throw error;
  }
}

function copilotFilesMatchOrAccessState(sourcePath, destinationPath) {
  try {
    return copilotFilesMatch(sourcePath, destinationPath);
  } catch (error) {
    if (error?.destinationAccess === true) return "unreadable";
    throw error;
  }
}

function isDestinationAccessError(error) {
  return error?.code === "EACCES" || error?.code === "EPERM";
}

/**
 * List source entries that are readable by the current runtime. Bun can expose
 * dangling optional-package links in its directory listing even though their
 * targets are unavailable; those entries must not abort staging.
 */
function copilotSourceEntries(sourceDir, skipDanglingOptional) {
  const entries = [];
  for (const entry of NodeFS.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = NodePath.resolve(sourceDir, entry.name);
    let sourceStat;
    try {
      sourceStat = NodeFS.statSync(sourcePath);
    } catch (error) {
      if (skipDanglingOptional && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) continue;
      throw error;
    }
    if (sourceStat.isDirectory()) {
      entries.push({ name: entry.name, kind: "directory" });
    } else if (sourceStat.isFile()) {
      entries.push({ name: entry.name, kind: "file" });
    }
  }
  return entries;
}

/** Copy a readable Copilot package tree while skipping unavailable optional links. */
function copyCopilotTree(sourceDir, destinationDir, skipDanglingOptional) {
  NodeFS.mkdirSync(destinationDir, { recursive: true });
  for (const sourceEntry of copilotSourceEntries(sourceDir, skipDanglingOptional)) {
    const sourcePath = NodePath.resolve(sourceDir, sourceEntry.name);
    const destinationPath = NodePath.resolve(destinationDir, sourceEntry.name);
    if (sourceEntry.kind === "directory") {
      copyCopilotTree(sourcePath, destinationPath, skipDanglingOptional);
      continue;
    }
    NodeFS.copyFileSync(sourcePath, destinationPath);
    NodeFS.chmodSync(destinationPath, NodeFS.statSync(sourcePath).mode & 0o777);
  }
}

/** Compare file contents in bounded chunks so equal-size files remain content-checked. */
function copilotFilesMatch(sourcePath, destinationPath) {
  const sourceStat = NodeFS.statSync(sourcePath);
  let destinationStat;
  try {
    destinationStat = NodeFS.statSync(destinationPath);
  } catch (error) {
    throw markDestinationAccessError(error);
  }
  if (sourceStat.size !== destinationStat.size) return false;

  const sourceFd = NodeFS.openSync(sourcePath, "r");
  let destinationFd;
  try {
    destinationFd = NodeFS.openSync(destinationPath, "r");
  } catch (error) {
    NodeFS.closeSync(sourceFd);
    throw markDestinationAccessError(error);
  }
  const sourceBuffer = Buffer.allocUnsafe(64 * 1024);
  const destinationBuffer = Buffer.allocUnsafe(sourceBuffer.length);
  try {
    let offset = 0;
    while (offset < sourceStat.size) {
      const expected = Math.min(sourceBuffer.length, sourceStat.size - offset);
      const sourceRead = NodeFS.readSync(sourceFd, sourceBuffer, 0, expected, offset);
      let destinationRead;
      try {
        destinationRead = NodeFS.readSync(destinationFd, destinationBuffer, 0, expected, offset);
      } catch (error) {
        throw markDestinationAccessError(error);
      }
      if (sourceRead === 0 || destinationRead === 0) return false;
      if (sourceRead !== destinationRead) return false;
      if (!sourceBuffer.subarray(0, sourceRead).equals(destinationBuffer.subarray(0, destinationRead))) {
        return false;
      }
      offset += sourceRead;
    }
    return true;
  } finally {
    NodeFS.closeSync(sourceFd);
    NodeFS.closeSync(destinationFd);
  }
}

/** Mark access failures raised while reading destination files as lock-preservation cases. */
function markDestinationAccessError(error) {
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    error.destinationAccess = true;
  }
  return error;
}

/** Copy the complete Copilot CLI package tree and target platform package into a server tree. */
export function copyCopilotSdkToDir({ destServerDir, serverPackageRoot, platform, arch }) {
  const { platformPkg, copilotPackageDir, platformPackageDir } = resolveCopilotSdkSources(
    serverPackageRoot,
    platform,
    arch,
  );
  const githubDir = NodePath.resolve(destServerDir, "node_modules", "@github");
  const copilotDst = NodePath.resolve(githubDir, "copilot");
  const platformDst = NodePath.resolve(githubDir, platformPkg.slice("@github/".length));
  NodeFS.mkdirSync(githubDir, { recursive: true });
  if (!copilotTreesMatch(copilotPackageDir, copilotDst)) {
    NodeFS.rmSync(copilotDst, { recursive: true, force: true });
    copyCopilotTree(copilotPackageDir, copilotDst, true);
  }
  if (!copilotTreesMatch(platformPackageDir, platformDst, false)) {
    NodeFS.rmSync(platformDst, { recursive: true, force: true });
    copyCopilotTree(platformPackageDir, platformDst, false);
  }
  return { platformPkg, copilotDst, platformDst };
}

/** Stage Copilot's bundled CLI packages beside a bundled `server.cjs` for development. */
export function copyCopilotSdkNextTo(
  serverCjsOut,
  serverPackageRoot,
  platform = process.platform,
  arch = process.arch,
) {
  return copyCopilotSdkToDir({
    destServerDir: NodePath.dirname(serverCjsOut),
    serverPackageRoot,
    platform,
    arch,
  });
}

/** Detect a complete staged Copilot package tree beside a bundled server entry. */
export function findCopilotSdkPath(serverCjsOut, platform, arch) {
  const serverDir = NodePath.dirname(serverCjsOut);
  const platformPkg = copilotSdkPlatformPackageName(platform, arch);
  const copilotIndex = NodePath.resolve(serverDir, "node_modules", "@github", "copilot", "index.js");
  const platformEntry = NodePath.resolve(
    serverDir,
    "node_modules",
    "@github",
    platformPkg.slice("@github/".length),
  );
  return NodeFS.existsSync(copilotIndex) && NodeFS.existsSync(platformEntry) ? copilotIndex : undefined;
}

/** Bundle the server and its isolated workers from one compiled server tree. */
export async function buildServerRuntimeBundles({
  serverRoot,
  serverOutFile,
  ptyHostOutFile,
  canonicalWriterWorkerOutFile = NodePath.resolve(NodePath.dirname(serverOutFile), "canonical-agent-writer.worker.cjs"),
  executionWorkerOutFile = NodePath.resolve(NodePath.dirname(serverOutFile), "execution.worker.cjs"),
  processStartWorkerOutFile = NodePath.resolve(NodePath.dirname(serverOutFile), "process-start.worker.cjs"),
  production = false,
}) {
  const shared = {
    bundle: true,
    platform: "node",
    target: "node20",
    sourcemap: true,
    format: "cjs",
  external: ["bun", "bun:sqlite", "node-pty", "electron", "koffi"],
    banner: {
      js: importMetaUrlBanner,
    },
    define: {
      "import.meta.url": "__importMetaUrl",
      ...(production ? { "process.env.NODE_ENV": '"production"' } : {}),
    },
  };
  const bundles = [
    build({
      ...shared,
      entryPoints: [NodePath.resolve(serverRoot, "dist-tsc/index.js")],
      outfile: serverOutFile,
    }),
    build({
      ...shared,
      entryPoints: [
        NodePath.resolve(serverRoot, "dist-tsc/features/terminal/host/pty-host-entry.js"),
      ],
      outfile: ptyHostOutFile,
    }),
  ];
  bundles.push(build({
    ...shared,
    entryPoints: [NodePath.resolve(serverRoot, "dist-tsc/features/agents/canonical/canonical-agent-writer.worker.js")],
    outfile: canonicalWriterWorkerOutFile,
  }));
  bundles.push(build({
    ...shared,
    entryPoints: [NodePath.resolve(serverRoot, "dist-tsc/features/agents/execution/execution.worker.js")],
    outfile: executionWorkerOutFile,
  }));
  bundles.push(build({
    ...shared,
    entryPoints: [NodePath.resolve(serverRoot, "dist-tsc/runtime/process/process-start.worker.js")],
    outfile: processStartWorkerOutFile,
  }));
  await Promise.all(bundles);
}

/**
 * Produce the server and PTY-host bundles from current server sources.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot] Repository root; defaults to the parent of `scripts/`.
 */
export async function rebuildServerDevBundle(options = {}) {
  const repoRoot = options.repoRoot ?? repoRootFromScript();
  const desktopRoot = NodePath.resolve(repoRoot, "apps/desktop");
  const serverRoot = NodePath.resolve(repoRoot, "apps/server");
  const serverOutFile = NodePath.resolve(desktopRoot, "dist/server/server.cjs");
  const ptyHostOutFile = NodePath.resolve(desktopRoot, "dist/server/pty-host.cjs");

  console.log("[server-dev-bundle] Compiling apps/server with swc...");
  compileServerWithSwc(serverRoot);

  console.log("[server-dev-bundle] Bundling server and PTY host...");
  await buildServerRuntimeBundles({
    serverRoot,
    serverOutFile,
    ptyHostOutFile,
  });

  copyCopilotSdkNextTo(serverOutFile, serverRoot);

  const drizzleSrc = NodePath.resolve(serverRoot, "drizzle");
  const drizzleDst = NodePath.resolve(desktopRoot, "dist/server/drizzle");
  if (NodeFS.existsSync(drizzleSrc)) {
    if (NodeFS.existsSync(drizzleDst)) NodeFS.rmSync(drizzleDst, { recursive: true, force: true });
    NodeFS.cpSync(drizzleSrc, drizzleDst, { recursive: true });
    console.log(`[server-dev-bundle] Copied Drizzle migrations -> ${drizzleDst}`);
  }

  console.log(`[server-dev-bundle] Complete: ${serverOutFile}, ${ptyHostOutFile}, execution.worker.cjs, process-start.worker.cjs`);
}
