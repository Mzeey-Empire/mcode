import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeFileRpc } from "../file-rpc.js";

const broadcast = vi.hoisted(() => vi.fn());

vi.mock("../../../../../application/transport/push.js", () => ({ broadcast }));

describe("file RPC", () => {
  beforeEach(() => {
    broadcast.mockClear();
  });

  it.each([
    ["file.list", { workspaceId: "workspace-1" }, ["src/file.ts"], "list"],
    ["file.read", { workspaceId: "workspace-1", relativePath: "src/file.ts" }, "contents", "read"],
  ] as const)("routes %s without side effects", async (method, params, expected, serviceMethod) => {
    const fileService = {
      list: vi.fn().mockResolvedValue(["src/file.ts"]),
      read: vi.fn().mockResolvedValue("contents"),
      refresh: vi.fn(),
    };

    await expect(routeFileRpc(method, params, { fileService })).resolves.toEqual(expected);
    expect(fileService[serviceMethod]).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts files.changed when file.refresh reports a dirty-set delta", async () => {
    const fileService = {
      list: vi.fn(),
      read: vi.fn(),
      refresh: vi.fn().mockResolvedValue({ changedPaths: ["src/file.ts"], wholeWorkspace: false }),
    };

    await routeFileRpc("file.refresh", { workspaceId: "workspace-1", threadId: "thread-1" }, { fileService });

    expect(broadcast).toHaveBeenCalledWith("files.changed", {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      changedPaths: ["src/file.ts"],
      wholeWorkspace: false,
    });
  });

  it("stays silent when file.refresh finds no delta", async () => {
    const fileService = {
      list: vi.fn(),
      read: vi.fn(),
      refresh: vi.fn().mockResolvedValue(null),
    };

    await routeFileRpc("file.refresh", { workspaceId: "workspace-1" }, { fileService });

    expect(broadcast).not.toHaveBeenCalled();
  });
});
