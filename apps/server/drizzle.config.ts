import { defineConfig } from "drizzle-kit";
import { getRuntimePaths } from "../../scripts/agent/runtime-contract.mjs";

/** CLI commands (`db:migrate`, `db:push`, …) target the checkout's seeded dev database. */
function devSqliteUrl(): string {
  const posixPath = getRuntimePaths().dbPath.replace(/\\/g, "/");
  return `file:${posixPath}`;
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/runtime/persistence/sqlite/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: devSqliteUrl(),
  },
});
