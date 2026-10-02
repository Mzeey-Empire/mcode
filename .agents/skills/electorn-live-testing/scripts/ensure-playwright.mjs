import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Creates an isolated Playwright installation under the worktree runtime directory. */
export function ensurePlaywright(repoRoot = process.cwd(), { install = installPlaywright } = {}) {
  const root = NodePath.resolve(repoRoot);
  const scratchDir = NodePath.join(root, ".dev", "playwright-scratch");
  const packageFile = NodePath.join(scratchDir, "package.json");
  const nodeModulesDir = NodePath.join(scratchDir, "node_modules");
  NodeFS.mkdirSync(scratchDir, { recursive: true });
  ensureScratchPackage(packageFile);
  const scratchRequire = NodeModule.createRequire(packageFile);
  if (isPlaywrightInstalled(scratchRequire, nodeModulesDir)) return nodeModulesDir;
  install(scratchDir);
  if (verifyInstalledPlaywright(packageFile, nodeModulesDir)) return nodeModulesDir;
  throw new Error("Playwright was not installed inside the scratch package");
}

/** Creates the private scratch package manifest that isolated tool installs share. */
export function ensureScratchPackage(packageFile) {
  if (NodeFS.existsSync(packageFile)) {
    const manifest = JSON.parse(NodeFS.readFileSync(packageFile, "utf8"));
    if (manifest.private !== true) {
      throw new Error("Refusing to modify a scratch package that is not private");
    }
    return;
  }
  NodeFS.writeFileSync(
    packageFile,
    `${JSON.stringify({ name: "mcode-electron-live-testing", private: true }, null, 2)}\n`,
    "utf8",
  );
}

function isPlaywrightInstalled(scratchRequire, nodeModulesDir) {
  try {
    return isInside(nodeModulesDir, scratchRequire.resolve("playwright"));
  } catch {
    // A missing local dependency is the expected installation trigger.
    return false;
  }
}

function installPlaywright(scratchDir) {
  const installer = process.versions.bun ? process.execPath : "bun";
  const install = NodeChildProcess.spawnSync(installer, ["add", "playwright"], {
    cwd: scratchDir,
    stdio: "inherit",
  });
  if (install.error) {
    throw new Error(`Playwright installation could not start: ${install.error.message}`);
  }
  if (install.status !== 0) {
    throw new Error(
      `Playwright installation failed with exit code ${install.status ?? "none"} and signal ${install.signal ?? "none"}`,
    );
  }
}

function verifyInstalledPlaywright(packageFile, nodeModulesDir) {
  // Bun retains missing directory entries after installation. A fresh process owns a fresh resolver.
  const script = "import { createRequire } from 'node:module'; process.stdout.write(createRequire(process.argv.at(-1)).resolve('playwright'));";
  const resolution = NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", script, packageFile], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (resolution.error) {
    throw new Error(`Playwright installation verification could not finish: ${resolution.error.message}`);
  }
  const entry = resolution.stdout.trim();
  return resolution.status === 0 && isInside(nodeModulesDir, entry) && NodeFS.existsSync(entry);
}

/** Returns true when `candidate` resolves to a path strictly inside `parent`. */
export function isInside(parent, candidate) {
  const relativePath = NodePath.relative(parent, candidate);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !NodePath.isAbsolute(relativePath);
}

if (import.meta.main) {
  console.log(ensurePlaywright());
}
