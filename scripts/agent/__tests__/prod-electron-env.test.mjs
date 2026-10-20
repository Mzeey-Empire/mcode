/** Tests the environment `prod:desktop` hands to Electron. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";

import { buildProdElectronEnv } from "../../../apps/desktop/scripts/prod-electron-env.mjs";
import { buildRuntimeStateEnv } from "../runtime-contract.mjs";

NodeTest.test("prod:desktop drops the dev runtime variables a dev terminal exports", () => {
  const devTerminalEnv = {
    ...buildRuntimeStateEnv("/work/tree"),
    PATH: "/usr/bin",
    MCODE_PORT: "19400",
  };

  NodeAssertStrict.default.deepEqual(buildProdElectronEnv(devTerminalEnv), {
    PATH: "/usr/bin",
    MCODE_PORT: "19400",
    NODE_ENV: "production",
  });
});

NodeTest.test("prod:desktop removes ELECTRON_RUN_AS_NODE and forces production mode", () => {
  const env = buildProdElectronEnv({ ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "development", HOME: "/home/me" });

  NodeAssertStrict.default.deepEqual(env, { HOME: "/home/me", NODE_ENV: "production" });
});
