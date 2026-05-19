import { defineConfig } from "vitest/config";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createTestDataDir } from "../../scripts/vitest-test-dir";

const testDataDir = createTestDataDir();
const serverPackageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      MCODE_DATA_DIR: testDataDir,
      MCODE_DRIZZLE_MIGRATIONS_DIR: resolve(serverPackageRoot, "drizzle"),
      // A globally-set BETTER_SQLITE3_BINDING (e.g. dev shell pointing at the
      // installed app's Electron-ABI binary) crashes tests under host Node.
      // Empty string short-circuits the truthy check in store/database.ts so
      // better-sqlite3 falls back to its default Node binding lookup.
      BETTER_SQLITE3_BINDING: "",
    },
    globalSetup: ["../../scripts/vitest-global-setup.ts"],
  },
});
