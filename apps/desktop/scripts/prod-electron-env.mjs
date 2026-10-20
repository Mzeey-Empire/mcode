import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { buildRuntimeStateEnv, getRuntimePaths } from "../../../scripts/agent/runtime-contract.mjs";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "..", "..");
const DEV_RUNTIME_VARIABLES = Object.keys(buildRuntimeStateEnv(REPO_ROOT));

/**
 * Builds the environment for `prod:desktop` from the one it inherited.
 *
 * Drops ELECTRON_RUN_AS_NODE (see `prod-electron.mjs`). A terminal that ran a dev launcher
 * keeps the variables from `buildRuntimeStateEnv` set, and they would label the production
 * build "Dev" and point it at the checkout's `.dev` state, so those are dropped too. They are
 * kept when `MCODE_DATA_DIR` names another directory: launch harnesses set them on purpose to
 * run the build against isolated state.
 *
 * @param {NodeJS.ProcessEnv} inherited
 * @param {string} [repoRoot]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildProdElectronEnv(inherited, repoRoot = REPO_ROOT) {
  const env = { ...inherited, NODE_ENV: "production" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (pointsAtCheckoutDevState(inherited, repoRoot)) {
    for (const name of DEV_RUNTIME_VARIABLES) delete env[name];
  }
  return env;
}

function pointsAtCheckoutDevState(inherited, repoRoot) {
  const dataDir = inherited.MCODE_DATA_DIR;
  return dataDir !== undefined && NodePath.resolve(dataDir) === getRuntimePaths(repoRoot).devDir;
}
