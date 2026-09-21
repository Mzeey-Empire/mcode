import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ensureScratchPackage, isInside } from "./ensure-playwright.mjs";

/** Resolves an ffmpeg binary, installing ffmpeg-static into the isolated scratch package when needed. */
export function ensureFfmpeg(repoRoot = process.cwd()) {
  const root = NodePath.resolve(repoRoot);
  const scratchDir = NodePath.join(root, ".dev", "playwright-scratch");
  const packageFile = NodePath.join(scratchDir, "package.json");
  const nodeModulesDir = NodePath.join(scratchDir, "node_modules");
  NodeFS.mkdirSync(scratchDir, { recursive: true });
  ensureScratchPackage(packageFile);
  const scratchRequire = NodeModule.createRequire(packageFile);
  const existing = resolveFfmpegBinary(scratchRequire, nodeModulesDir);
  if (existing) return existing;
  installFfmpegStatic(scratchDir);
  const installed = waitForFfmpegBinary(scratchRequire, nodeModulesDir);
  if (installed) return installed;
  throw new Error("ffmpeg-static was not installed inside the scratch package");
}

function resolveFfmpegBinary(scratchRequire, nodeModulesDir) {
  try {
    const binaryPath = scratchRequire("ffmpeg-static");
    if (
      typeof binaryPath === "string" &&
      isInside(nodeModulesDir, binaryPath) &&
      NodeFS.existsSync(binaryPath)
    ) {
      return binaryPath;
    }
  } catch {
    // A missing local dependency is the expected installation trigger.
  }
  return null;
}

function installFfmpegStatic(scratchDir) {
  const installer = process.versions.bun ? process.execPath : "bun";
  const install = NodeChildProcess.spawnSync(installer, ["add", "ffmpeg-static"], {
    cwd: scratchDir,
    stdio: "inherit",
  });
  if (install.error) {
    throw new Error(`ffmpeg-static installation could not start: ${install.error.message}`);
  }
  if (install.status !== 0) {
    throw new Error(
      `ffmpeg-static installation failed with exit code ${install.status ?? "none"} and signal ${install.signal ?? "none"}`,
    );
  }
}

function waitForFfmpegBinary(scratchRequire, nodeModulesDir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const binaryPath = resolveFfmpegBinary(scratchRequire, nodeModulesDir);
    if (binaryPath) return binaryPath;
    // Bun can finish the child process before Windows exposes the installed files.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return null;
}

if (import.meta.main) {
  console.log(ensureFfmpeg());
}
