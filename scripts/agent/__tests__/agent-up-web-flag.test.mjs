import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { agentUp, buildWebAutomationEnv, isWebAutomationEnabled, setAgentUpTestHooks } from "../agent-up.mjs";
import { seedFixtureRepo } from "../fixture-repo.mjs";
import { getRuntimePaths, readPortsFile } from "../runtime-contract.mjs";
import { markRuntimeDatabase } from "../runtime-database.mjs";

NodeTest.test("web automation forwarding stays disabled unless explicitly enabled", () => {
  NodeAssertStrict.default.equal(isWebAutomationEnabled({}), false);
  NodeAssertStrict.default.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "0" }), false);
  NodeAssertStrict.default.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "true" }), true);
  NodeAssertStrict.default.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "1" }), true);
});

NodeTest.test("web automation opt-in is forwarded to both runtime children", () => {
  NodeAssertStrict.default.deepEqual(buildWebAutomationEnv({ MCODE_WEB_AUTOMATION: "1" }), {
    MCODE_WEB_AUTOMATION: "1",
    VITE_MCODE_WEB_AUTOMATION: "1",
  });
  NodeAssertStrict.default.deepEqual(buildWebAutomationEnv({ MCODE_WEB_AUTOMATION: "0" }), {
    MCODE_WEB_AUTOMATION: "0",
    VITE_MCODE_WEB_AUTOMATION: "0",
  });
});

NodeTest.test("plain agentUp publishes a complete contract for its standalone server", async () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-up-web-"));
  const paths = getRuntimePaths(repo);
  const bundle = NodePath.join(repo, "apps", "desktop", "dist", "server", "server.cjs");
  const launches = [];
  const restoreHooks = setAgentUpTestHooks({
    computeAvailablePorts: async () => ({ serverPort: 41_225, webPort: 41_226 }),
    getElectronBinary: () => process.execPath,
    spawnLogged: (_command, args, { env }) => {
      launches.push({ args, env });
      return { pid: 80_000 + launches.length };
    },
  });
  try {
    NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), ".dev/\n");
    NodeFS.mkdirSync(paths.dbDir, { recursive: true });
    NodeFS.writeFileSync(paths.dbPath, "test database\n");
    markRuntimeDatabase(repo, "empty");
    seedFixtureRepo(repo);
    NodeFS.mkdirSync(NodePath.dirname(bundle), { recursive: true });
    NodeFS.writeFileSync(bundle, "// bundle\n");

    await agentUp(repo);

    const contract = readPortsFile(repo);
    NodeAssertStrict.default.equal(contract.serverPort, 41_225);
    NodeAssertStrict.default.equal(contract.healthUrl, "http://127.0.0.1:41225/health");
    NodeAssertStrict.default.deepEqual(launches.map(({ args }) => args[0]), [bundle, "run"]);
    NodeAssertStrict.default.equal(launches[0].env.MCODE_AUTH_TOKEN, contract.seedLogin.token);
    NodeAssertStrict.default.equal(launches[1].env.VITE_MCODE_RUNTIME_CONTRACT, paths.portsFile);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});
