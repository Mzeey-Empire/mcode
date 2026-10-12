import { defineConfig } from "vitest/config";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createTestDataDir } from "../../scripts/vitest-test-dir";

const testDataDir = createTestDataDir();
const serverPackageRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

// Each fork is a Bun process (`bun --bun vitest`). Two forks keep the Windows
// process-integration tests, which spawn PowerShell, git, and job-object trees, inside
// their timing bounds. CI runs this suite alone (turbo --concurrency=1) on 4 vCPU Linux
// runners, so a third fork still leaves a core for the main process and spawned children.
function serverTestWorkers(): number {
  return process.env.CI && process.platform === "linux" ? 3 : 2;
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    maxWorkers: serverTestWorkers(),
    env: {
      MCODE_DATA_DIR: testDataDir,
      MCODE_DRIZZLE_MIGRATIONS_DIR: NodePath.resolve(serverPackageRoot, "drizzle"),
    },
    globalSetup: ["../../scripts/vitest-global-setup.ts"],
    server: {
      deps: {
        inline: ["zod"],
      },
    },
  },
});
