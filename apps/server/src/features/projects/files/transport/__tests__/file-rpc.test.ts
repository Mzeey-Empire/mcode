import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeFileRpc } from "../file-rpc.js";

const broadcast = vi.hoisted(() => vi.fn());

vi.mock("../../../../../application/transport/push.js", () => ({ broadcast }));

describe("file RPC", () => {
  beforeEach(() => {
    broadcast.mockClear();
  });

  it.each([
    ["file.list", { workspaceId: "workspace-1" }, { paths: ["src/file.ts"], truncated: false }, "list"],
    ["file.read", { workspaceId: "workspace-1", relativePath: "src/file.ts" }, { kind: "text", path: "src/file.ts", size: 8, encoding: "utf-8", content: "contents", changedLines: [[12, 15]] }, "read"],
    ["file.changes", { workspaceId: "workspace-1" }, { git: true, entries: [{ path: "src/file.ts", mark: "M" }], truncated: false }, "changes"],
  ] as const)("routes %s without side effects", async (method, params, expected, serviceMethod) => {
    const fileService = {
      list: vi.fn().mockResolvedValue({ paths: ["src/file.ts"], truncated: false }),
      read: vi.fn().mockResolvedValue({ kind: "text", path: "src/file.ts", size: 8, encoding: "utf-8", content: "contents", changedLines: [[12, 15]] }),
      changes: vi.fn().mockResolvedValue({ git: true, entries: [{ path: "src/file.ts", mark: "M" }], truncated: false }),
      refresh: vi.fn(),
    };

    await expect(routeFileRpc(method, params, { fileService })).resolves.toEqual(expected);
    expect(fileService[serviceMethod]).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts files.changed when file.refresh reports a dirty-set delta", async () => {
    const fileService = {
      changes: vi.fn(),
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
      changes: vi.fn(),
      list: vi.fn(),
      read: vi.fn(),
      refresh: vi.fn().mockResolvedValue(null),
    };

    await routeFileRpc("file.refresh", { workspaceId: "workspace-1" }, { fileService });

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("forwards the thread and explicit SVG source request", async () => {
    const fileService = { list: vi.fn(), changes: vi.fn(), refresh: vi.fn(), read: vi.fn().mockResolvedValue({ kind: "binary", path: "logo.svg", size: 4 }) };
    await expect(routeFileRpc("file.read", { workspaceId: "workspace-1", relativePath: "logo.svg", threadId: "thread-1", as: "text" }, { fileService })).resolves.toEqual({ kind: "binary", path: "logo.svg", size: 4 });
    expect(fileService.read).toHaveBeenCalledWith("workspace-1", "logo.svg", "thread-1", "text");
  });
});
