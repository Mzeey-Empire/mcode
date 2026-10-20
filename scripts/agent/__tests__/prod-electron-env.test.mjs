/** Tests the environment `prod:desktop` hands to Electron. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { buildProdElectronEnv } from "../../../apps/desktop/scripts/prod-electron-env.mjs";
import { buildRuntimeStateEnv } from "../runtime-contract.mjs";

const REPO_ROOT = NodePath.resolve("/work/tree");

NodeTest.test("prod:desktop drops the dev runtime variables a dev terminal exports", () => {
  const devTerminalEnv = {
    ...buildRuntimeStateEnv(REPO_ROOT),
    PATH: "/usr/bin",
    MCODE_PORT: "19400",
  };

  NodeAssertStrict.default.deepEqual(buildProdElectronEnv(devTerminalEnv, REPO_ROOT), {
    PATH: "/usr/bin",
    MCODE_PORT: "19400",
    NODE_ENV: "production",
  });
});

NodeTest.test("prod:desktop keeps runtime variables a launch harness points at isolated state", () => {
  const harnessEnv = {
    MCODE_AGENT_RUNTIME: "1",
    MCODE_DATA_DIR: NodePath.resolve("/tmp/launch-smoke/data"),
    MCODE_ELECTRON_USER_DATA_DIR: NodePath.resolve("/tmp/launch-smoke/user-data"),
  };

  NodeAssertStrict.default.deepEqual(buildProdElectronEnv(harnessEnv, REPO_ROOT), {
    ...harnessEnv,
    NODE_ENV: "production",
  });
});

NodeTest.test("prod:desktop removes ELECTRON_RUN_AS_NODE and forces production mode", () => {
  const env = buildProdElectronEnv({ ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "development", HOME: "/home/me" }, REPO_ROOT);

  NodeAssertStrict.default.deepEqual(env, { HOME: "/home/me", NODE_ENV: "production" });
});
