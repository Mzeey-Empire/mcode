import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceRepo } from "../../../features/projects/persistence/workspace-repo.js";
import { seedAgentRuntimeWorkspace } from "../dev-agent-seed.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../../features/projects/testing/owned-test-database.js";
import { openReadOnlyDatabase } from "../../persistence/sqlite/read-only-database.js";
import type { Database } from "bun:sqlite";

describe("seedAgentRuntimeWorkspace", () => {
  const tmpDirs: string[] = [];
  let db: Database | null = null;
  let owner: OwnedTestDatabase | undefined;

  afterEach(async () => {
    db?.close(true);
    db = null;
    await owner?.close();
    owner = undefined;
    for (const dir of tmpDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createFixtureRepo(): Promise<string> {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-seed-"));
    tmpDirs.push(root);
    const fixtureRepo = NodePath.join(root, "fixture-repo");
    NodeFS.mkdirSync(NodePath.join(fixtureRepo, ".git"), { recursive: true });
    return fixtureRepo;
  }

  function createRepo(): WorkspaceRepo {
    owner = createOwnedTestDatabase();
    db = openReadOnlyDatabase(owner.db.filename);
    return new WorkspaceRepo(db, owner.writer);
  }

  it("does nothing unless the agent runtime is enabled", async () => {
    const workspaceRepo = createRepo();
    const fixtureRepo = await createFixtureRepo();

    await seedAgentRuntimeWorkspace(
      { MCODE_AGENT_FIXTURE_REPO: fixtureRepo },
      { workspaceRepo },
    );

    expect(workspaceRepo.listAll()).toHaveLength(0);
  });

  it("creates the fixture workspace idempotently", async () => {
    const workspaceRepo = createRepo();
    const fixtureRepo = await createFixtureRepo();
    const env = {
      MCODE_AGENT_RUNTIME: "1",
      MCODE_AGENT_FIXTURE_REPO: fixtureRepo,
    };

    await seedAgentRuntimeWorkspace(env, { workspaceRepo });
    await seedAgentRuntimeWorkspace(env, { workspaceRepo });

    const workspaces = workspaceRepo.listAll();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      name: "fixture-repo",
      path: fixtureRepo,
      is_git_repo: true,
    });
  });

  it("rejects enabled runtime seeding without an existing fixture repo", async () => {
    const workspaceRepo = createRepo();

    await expect(
      seedAgentRuntimeWorkspace(
        { MCODE_AGENT_RUNTIME: "1", MCODE_AGENT_FIXTURE_REPO: NodePath.join(NodeOS.tmpdir(), "missing-fixture") },
        { workspaceRepo },
      ),
    ).rejects.toThrow(/does not exist/);
  });
});
