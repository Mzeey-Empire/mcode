import { describe, expect, it, vi } from "vitest";
import type { ProjectIcon } from "@mcode/contracts";
import { routeProjectIconRpc } from "../project-icon-rpc.js";

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
    const projectIconService = { resolve: vi.fn(), set: vi.fn().mockResolvedValue(icon) };

    const result = await routeProjectIconRpc("workspace.icon.set", { workspaceId: "workspace-1", iconPath: "brand.svg" }, { projectIconService });

    expect(result).toEqual(icon);
    expect(projectIconService.set).toHaveBeenCalledWith("workspace-1", "brand.svg");
    expect(broadcast).toHaveBeenCalledWith("workspace.iconChanged", { workspaceId: "workspace-1", icon });
  });

  it("does not push when storing fails", async () => {
    broadcast.mockClear();
    const projectIconService = { resolve: vi.fn(), set: vi.fn().mockRejectedValue(new Error("Choose a file inside the project.")) };

    await expect(routeProjectIconRpc("workspace.icon.set", { workspaceId: "workspace-1", iconPath: "../x.svg" }, { projectIconService }))
      .rejects.toThrow("Choose a file inside the project.");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("wraps resolved icons in the result envelope", async () => {
    const projectIconService = { resolve: vi.fn().mockResolvedValue([icon]), set: vi.fn() };

    await expect(routeProjectIconRpc("workspace.icon.resolve", { workspaceIds: ["workspace-1"] }, { projectIconService }))
      .resolves.toEqual({ icons: [icon] });
  });
});
