import { buildRuntimeStateEnv } from "../../../scripts/agent/runtime-contract.mjs";

const DEV_RUNTIME_VARIABLES = Object.keys(buildRuntimeStateEnv(process.cwd()));

/**
 * Builds the environment for `prod:desktop` from the one it inherited.
 *
 * Drops ELECTRON_RUN_AS_NODE (see `prod-electron.mjs`) and every variable the dev launchers
 * export through `buildRuntimeStateEnv`. A terminal that ran a dev launcher keeps those set,
 * and they would label the production build "Dev" and point it at the checkout's `.dev` state.
 *
 * @param {NodeJS.ProcessEnv} inherited
 * @returns {NodeJS.ProcessEnv}
 */
export function buildProdElectronEnv(inherited) {
  const env = { ...inherited, NODE_ENV: "production" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of DEV_RUNTIME_VARIABLES) delete env[name];
  return env;
}
