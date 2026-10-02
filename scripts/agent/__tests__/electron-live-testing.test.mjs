import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { probeCdpVersion } from "../../../.agents/skills/electorn-live-testing/scripts/start-electron.mjs";

const validCdpVersion = {
  Browser: "Electron/37.3.1",
  "Protocol-Version": "1.3",
  webSocketDebuggerUrl: "ws://127.0.0.1:43000/devtools/browser/session",
};

NodeTest.test("bounds a fetch that never settles", async () => {
  const startedAt = performance.now();
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    timeoutMs: 20,
    fetchImpl: async () => new Promise(() => {}),
  });

  NodeAssertStrict.default.equal(ready, false);
  NodeAssertStrict.default.ok(performance.now() - startedAt < 500);
});

NodeTest.test("rejects an HTTP 200 response without CDP metadata", async () => {
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "ok" }) }),
  });

  NodeAssertStrict.default.equal(ready, false);
});

NodeTest.test("accepts a valid CDP version response", async () => {
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    fetchImpl: async () => ({ ok: true, json: async () => validCdpVersion }),
  });

  NodeAssertStrict.default.equal(ready, true);
});

function isolatedInstallRoot(t) {
  const base = NodePath.resolve(".dev", "verification", "playwright-install-check");
  NodeFS.mkdirSync(base, { recursive: true });
  const root = NodeFS.mkdtempSync(NodePath.join(base, "offline-"));
  t.after(() => {
    NodeAssertStrict.default.equal(NodePath.dirname(NodePath.resolve(root)), base);
    NodeAssertStrict.default.ok(NodePath.basename(root).startsWith("offline-"));
    NodeFS.rmSync(root, { recursive: true });
  });
  return root;
}

function runInstallerUnderBun(root, body) {
  const helper = NodeURL.pathToFileURL(NodePath.resolve(".agents/skills/electorn-live-testing/scripts/ensure-playwright.mjs")).href;
  const script = `import { ensurePlaywright } from ${JSON.stringify(helper)};
    import * as fs from "node:fs";
    import * as path from "node:path";
    const root = process.argv.at(-1);
    ${body}`;
  return NodeChildProcess.spawnSync("bun", ["--input-type=module", "-e", script, root], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
}

NodeTest.test("verifies a fresh scratch install after Bun first resolves the dependency as missing", (t) => {
  const root = isolatedInstallRoot(t);
  const install = runInstallerUnderBun(root, `
    let installed = 0;
    const modules = ensurePlaywright(root, { install(scratch) {
      installed++;
      const directory = path.join(scratch, "node_modules", "playwright");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "playwright", version: "0.0.0-fixture", main: "index.js" }));
      fs.writeFileSync(path.join(directory, "index.js"), "module.exports = {};\\n");
    } });
    console.log(JSON.stringify({ modules, installed }));
  `);
  NodeAssertStrict.default.equal(install.status, 0, install.stderr || install.error?.message);
  const modules = NodePath.join(root, ".dev", "playwright-scratch", "node_modules");
  NodeAssertStrict.default.deepEqual(JSON.parse(install.stdout), { modules, installed: 1 });
  const reuse = runInstallerUnderBun(root, `
    console.log(JSON.stringify({ modules: ensurePlaywright(root, { install() { throw new Error("Existing scratch package was reinstalled"); } }) }));
  `);
  NodeAssertStrict.default.equal(reuse.status, 0, reuse.stderr || reuse.error?.message);
  NodeAssertStrict.default.deepEqual(JSON.parse(reuse.stdout), { modules });
});

NodeTest.test("rejects a successful installer when Playwright resolves only from an ancestor package", (t) => {
  const root = isolatedInstallRoot(t);
  const directory = NodePath.join(root, "node_modules", "playwright");
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "package.json"), JSON.stringify({ name: "playwright", version: "0.0.0-fixture", main: "index.js" }));
  NodeFS.writeFileSync(NodePath.join(directory, "index.js"), "module.exports = {};\n");
  const rejected = runInstallerUnderBun(NodePath.join(root, "child"), `
    try {
      ensurePlaywright(root, { install() {} });
      throw new Error("Ancestor package incorrectly satisfied the scratch installation");
    } catch (error) {
      console.log(JSON.stringify({ message: error.message }));
    }
  `);
  NodeAssertStrict.default.equal(rejected.status, 0, rejected.stderr || rejected.error?.message);
  NodeAssertStrict.default.deepEqual(JSON.parse(rejected.stdout), { message: "Playwright was not installed inside the scratch package" });
});
