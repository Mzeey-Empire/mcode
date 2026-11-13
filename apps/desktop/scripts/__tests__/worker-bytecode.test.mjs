import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { BUN_WORKER_FILENAMES, buildWorkerBytecode } from "../desktop-packaging/target-package/after-pack.mjs";
import { resolveBunExecutable } from "../desktop-packaging/target-package/ci-package.mjs";

const bunExecutable = resolveBunExecutable();

describe("packaged worker bytecode", () => {
  it("rebuilds the workers with bytecode and preserves their messages", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worker-bytecode-"));
    try {
      const source = NodePath.join(directory, "tiny-worker.js");
      NodeFS.writeFileSync(source, 'postMessage("worker-ready");\n');
      for (const filename of BUN_WORKER_FILENAMES) {
        buildSync({
          entryPoints: [source],
          bundle: true,
          platform: "node",
          format: "cjs",
          sourcemap: true,
          outfile: NodePath.join(directory, filename),
        });
      }

      buildWorkerBytecode({ packagedServerDir: directory, bunExecutable });

      for (const filename of BUN_WORKER_FILENAMES) {
        const workerFile = NodePath.join(directory, filename);
        expect(NodeFS.existsSync(workerFile)).toBe(true);
        expect(NodeFS.statSync(`${workerFile}.jsc`).size).toBeGreaterThan(0);
        expect(NodeFS.readFileSync(workerFile, "utf8")).not.toContain("sourceMappingURL=");
        expect(NodeFS.existsSync(`${workerFile}.map`)).toBe(false);
        const workerUrl = NodeURL.pathToFileURL(workerFile).href;
        const runnerFile = NodePath.join(directory, "runner.mjs");
        NodeFS.writeFileSync(runnerFile, `
          const deadline = setTimeout(() => process.exit(1), 5000);
          const worker = new Worker(new URL(${JSON.stringify(workerUrl)}));
          worker.onmessage = ({ data }) => {
            console.log(data);
            clearTimeout(deadline);
            process.exit(0);
          };
          worker.onerror = (error) => { console.error(error); process.exit(1); };
        `);
        const output = NodeChildProcess.execFileSync(bunExecutable, [runnerFile], { encoding: "utf8" });
        expect(output.trim()).toBe("worker-ready");
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);

  it("fails packaging with the missing worker's name", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worker-missing-"));
    try {
      expect(() => buildWorkerBytecode({ packagedServerDir: directory, bunExecutable }))
        .toThrow("execution.worker.cjs");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
