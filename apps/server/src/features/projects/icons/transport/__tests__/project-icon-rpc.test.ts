import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WS_METHODS, type ProjectIcon } from "@mcode/contracts";
import { WorkspaceRepo } from "../../../persistence/workspace-repo.js";
import { RealGitExecutor } from "../../../git/execution/index.js";
import { createOwnedTestDatabase } from "../../../testing/owned-test-database.js";
import { ProjectIconService } from "../../project-icon-service.js";
import { isProjectIconRpcMethod, routeProjectIconRpc } from "../project-icon-rpc.js";

const broadcast = vi.hoisted(() => vi.fn());

vi.mock("../../../../../application/transport/push.js", () => ({ broadcast }));

const icon: ProjectIcon = {
  workspaceId: "workspace-1",
  source: "chosen",
  chosenMissing: false,
  path: "brand.svg",
  version: "0123456789abcdef",
  url: "/workspace-images/workspace-1?path=brand.svg&use=icon&v=0123456789abcdef",
};

describe("project icon RPC", () => {
  it("returns the stored icon and pushes it to every client", async () => {
    const projectIconService = { resolve: vi.fn(), set: vi.fn().mockResolvedValue(icon), candidates: vi.fn() };

    const result = await routeProjectIconRpc("workspace.icon.set", { workspaceId: "workspace-1", iconPath: "brand.svg" }, { projectIconService });

    expect(result).toEqual(icon);
    expect(projectIconService.set).toHaveBeenCalledWith("workspace-1", "brand.svg");
    expect(broadcast).toHaveBeenCalledWith("workspace.iconChanged", { workspaceId: "workspace-1", icon });
  });

  it("does not push when storing fails", async () => {
    broadcast.mockClear();
    const projectIconService = { resolve: vi.fn(), set: vi.fn().mockRejectedValue(new Error("Choose a file inside the project.")), candidates: vi.fn() };

    await expect(routeProjectIconRpc("workspace.icon.set", { workspaceId: "workspace-1", iconPath: "../x.svg" }, { projectIconService }))
      .rejects.toThrow("Choose a file inside the project.");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("wraps resolved icons in the result envelope", async () => {
    const projectIconService = { resolve: vi.fn().mockResolvedValue([icon]), set: vi.fn(), candidates: vi.fn() };

    await expect(routeProjectIconRpc("workspace.icon.resolve", { workspaceIds: ["workspace-1"] }, { projectIconService }))
      .resolves.toEqual({ icons: [icon] });
  });

  it("routes candidate filtering and limits without broadcasting", async () => {
    broadcast.mockClear();
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-icon-rpc-"));
    const database = createOwnedTestDatabase();
    try {
      const workspaces = new WorkspaceRepo(database.db, database.writer);
      const workspace = await workspaces.create("project", root, true);
      NodeFS.mkdirSync(NodePath.join(root, "brand"));
      for (const path of ["other.svg", "brand/a.png", "brand/b.svg"]) NodeFS.writeFileSync(NodePath.join(root, path), "image");
      const projectIconService = new ProjectIconService({ workspaces, gitExecutor: new RealGitExecutor(), platform: process.platform });
      const method = "workspace.icon.candidates";
      const params = WS_METHODS()[method].params.parse({ workspaceId: workspace.id, query: "BRAND", limit: 1 });

      expect(isProjectIconRpcMethod(method)).toBe(true);
      const result = await routeProjectIconRpc(method, params, { projectIconService });
      expect(WS_METHODS()[method].result.parse(result)).toEqual({ files: ["brand/a.png"], total: 2 });
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      await database.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([0, -1, 1.5, 201])("rejects an invalid candidate limit of %s", (limit) => {
    const result = WS_METHODS()["workspace.icon.candidates"].params.safeParse({ workspaceId: "workspace-1", limit });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized candidate search", () => {
    const result = WS_METHODS()["workspace.icon.candidates"].params.safeParse({ workspaceId: "workspace-1", query: "a".repeat(1025) });
    expect(result.success).toBe(false);
  });
});
