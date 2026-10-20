import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDatabasePath } from "../database.js";

describe("resolveDatabasePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers an explicit path, then MCODE_DB_PATH", () => {
    vi.stubEnv("MCODE_DB_PATH", NodePath.join("env", "app.sqlite"));

    expect(resolveDatabasePath({ dbPath: NodePath.join("explicit", "app.sqlite") })).toBe(
      NodePath.join("explicit", "app.sqlite"),
    );
    expect(resolveDatabasePath()).toBe(NodePath.join("env", "app.sqlite"));
  });

  it("places mcode.db in the data dir whatever checkout the process runs in", () => {
    vi.stubEnv("MCODE_DB_PATH", undefined);
    vi.stubEnv("MCODE_DATA_DIR", NodePath.join("work", "tree", ".dev"));
    vi.stubEnv("MCODE_GIT_BRANCH", "feat/other");
    vi.stubEnv("MCODE_GIT_TOPLEVEL", NodePath.join("work", "tree"));

    expect(resolveDatabasePath()).toBe(NodePath.join("work", "tree", ".dev", "mcode.db"));
  });
});
