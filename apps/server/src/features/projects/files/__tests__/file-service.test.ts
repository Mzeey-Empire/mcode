import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileService } from "../file-service.js";
import type { GitExecOptions } from "../../git/execution/types.js";

function makeService(overrides?: {
  exec?: ReturnType<typeof vi.fn>;
  root?: string;
}): { service: FileService; exec: ReturnType<typeof vi.fn> } {
  const exec = overrides?.exec ?? vi.fn().mockResolvedValue({ stdout: "" });
  const root = overrides?.root ?? "C:/workspace";
  const workspaceRepo = { findById: vi.fn().mockReturnValue({ path: root }) };
  const threadRepo = {
    findById: vi.fn().mockReturnValue({ id: "thread-1", workspace_id: "workspace-1" }),
  };
  const gitWorktrees = { resolveWorkingDir: vi.fn().mockReturnValue(root) };
  const service = new FileService(
    workspaceRepo as never,
    threadRepo as never,
    gitWorktrees as never,
    { exec: async (args: string[], opts?: GitExecOptions) => {
      if (args.includes("--show-prefix")) return { stdout: "", stderr: "" };
      if (args.includes("--show-toplevel")) return { stdout: root, stderr: "" };
      const result = await exec(args, opts);
      opts?.onStdout?.(result.stdout);
      return result;
    } },
    { platform: process.platform } as never,
  );
  return { service, exec };
}

describe("FileService.refresh", () => {
  it("baselines silently on the first call and reports only later deltas", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: " M src/a.ts\0" })
      .mockResolvedValueOnce({ stdout: " M src/a.ts\0" })
      .mockResolvedValueOnce({ stdout: " M src/a.ts\0?? src/b.ts\0" });
    const { service } = makeService({ exec });

    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    await expect(service.refresh("workspace-1")).resolves.toEqual({
      changedPaths: ["src/b.ts"],
      wholeWorkspace: false,
    });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenLastCalledWith(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
      { cwd: "C:/workspace", retainStdout: false, onStdout: expect.any(Function) },
    );
  });

  it("reports the destination path for rename entries in -z output", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "R  new name.ts\0old name.ts\0" });
    const { service } = makeService({ exec });

    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    await expect(service.refresh("workspace-1")).resolves.toEqual({
      changedPaths: ["new name.ts"],
      wholeWorkspace: false,
    });
  });

  it("tracks thread scopes independently", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: " M src/a.ts\0" })
      .mockResolvedValueOnce({ stdout: " M src/a.ts\0" });
    const { service } = makeService({ exec });

    await expect(service.refresh("workspace-1", "thread-1")).resolves.toBeNull();
    // Same status under a different scope is still a first-seen baseline.
    await expect(service.refresh("workspace-1")).resolves.toBeNull();
  });

  it("reports wholeWorkspace when a delta exceeds the changed-path cap", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({
        stdout: Array.from({ length: 101 }, (_, i) => `?? dir/file-${i}.ts`).join("\0"),
      });
    const { service } = makeService({ exec });

    await expect(service.refresh("workspace-1")).resolves.toBeNull();
    await expect(service.refresh("workspace-1")).resolves.toEqual({
      changedPaths: [],
      wholeWorkspace: true,
    });
  });

  it("fingerprints the bounded listing when the scope is not a git repository", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-service-"));
    try {
      const workspaceRepo = { findById: vi.fn().mockReturnValue({ path: root }) };
      const service = new FileService(
        workspaceRepo as never,
        { findById: vi.fn().mockReturnValue(null) } as never,
        { resolveWorkingDir: vi.fn().mockReturnValue(root) } as never,
        { exec: vi.fn().mockRejectedValue(new Error("not a repo")) } as never,
        { platform: process.platform } as never,
      );

      await expect(service.refresh("workspace-1")).resolves.toBeNull();
      NodeFS.writeFileSync(NodePath.join(root, "new-file.ts"), "x");
      await expect(service.refresh("workspace-1")).resolves.toEqual({
        changedPaths: ["new-file.ts"],
        wholeWorkspace: false,
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FileService.list non-git fallback", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  function makeTreeService(root: string): FileService {
    const workspaceRepo = { findById: vi.fn().mockReturnValue({ path: root }) };
    const threadRepo = { findById: vi.fn().mockReturnValue(null) };
    const gitWorktrees = { resolveWorkingDir: vi.fn().mockReturnValue(root) };
    const exec = vi.fn().mockRejectedValue(new Error("not a repo"));
    return new FileService(
      workspaceRepo as never,
      threadRepo as never,
      gitWorktrees as never,
      { exec } as never,
      { platform: process.platform } as never,
    );
  }

  it("walks the directory tree when the workspace is not a git repo", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-service-"));
    tempDirs.push(root);
    NodeFS.mkdirSync(NodePath.join(root, "src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "src", "a.ts"), "a");
    NodeFS.writeFileSync(NodePath.join(root, "README.md"), "r");
    NodeFS.mkdirSync(NodePath.join(root, "node_modules", "pkg"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "node_modules", "pkg", "x.js"), "x");

    const files = await makeTreeService(root).list("workspace-1");

    expect(files.paths.sort()).toEqual(["README.md", "src/a.ts"]);
    expect(files.truncated).toBe(false);
  });

  it("rethrows the git error when the workspace is a repository", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-service-"));
    tempDirs.push(root);
    NodeFS.mkdirSync(NodePath.join(root, ".git"));

    await expect(makeTreeService(root).list("workspace-1")).rejects.toThrow("Failed to list files");
  });
});

describe("FileService viewer", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  function fixture() {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-file-view-"));
    tempDirs.push(root);
    return { root, ...makeService({ root }) };
  }

  it.each(["../x", "a/../../x", "a\\..\\x", "/absolute", "C:\\file.ts", "C:file.ts", "\\\\host\\share", "a//b", "a\\\\b", "", "x\0y", "file.ts:stream"])("rejects unsafe path %j", async (path) => {
    const { service } = fixture();
    await expect(service.read("workspace-1", path)).rejects.toThrow("Invalid file path");
  });

  it("accepts dots inside names and normalizes nested separators", async () => {
    const { root, service } = fixture();
    NodeFS.mkdirSync(NodePath.join(root, "src"));
    NodeFS.writeFileSync(NodePath.join(root, "src/a..b.ts"), "legal");
    await expect(service.read("workspace-1", "src\\a..b.ts")).resolves.toEqual({
      kind: "text", path: "src/a..b.ts", size: 5, encoding: "utf-8", content: "legal", changedLines: null,
    });
  });

  it("rejects escaping symlinks and returns a typed missing-file error", async () => {
    const { root, service } = fixture();
    const outside = fixture().root;
    NodeFS.writeFileSync(NodePath.join(outside, "secret.ts"), "secret");
    NodeFS.symlinkSync(outside, NodePath.join(root, "escape"), "junction");
    await expect(service.read("workspace-1", "escape/secret.ts")).rejects.toThrow("escapes workspace root");
    await expect(service.read("workspace-1", "missing.ts")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads 1 MB text while retaining the 256 KB mention cap", async () => {
    const { root, service } = fixture();
    const content = "x".repeat(1024 * 1024);
    NodeFS.writeFileSync(NodePath.join(root, "large.txt"), content);
    await expect(service.read("workspace-1", "large.txt")).resolves.toEqual({
      kind: "text", path: "large.txt", size: 1048576, encoding: "utf-8", content, changedLines: null,
    });
    expect(() => service.validateMentionPath("workspace-1", "large.txt")).toThrow("too large for injection");
  });

  it("returns too-large for 3 MB text and images above 20 MB", async () => {
    const { root, service } = fixture();
    NodeFS.writeFileSync(NodePath.join(root, "large.txt"), Buffer.alloc(3 * 1024 * 1024, 120));
    await expect(service.read("workspace-1", "large.txt")).resolves.toEqual({ kind: "too-large", path: "large.txt", size: 3145728, limit: 2097152 });
    NodeFS.writeFileSync(NodePath.join(root, "large.png"), Buffer.alloc(20 * 1024 * 1024 + 1));
    await expect(service.read("workspace-1", "large.png")).resolves.toEqual({ kind: "too-large", path: "large.png", size: 20971521, limit: 20971520 });
  });

  it("accepts text at exactly 2 MB and classifies oversized NUL-bearing files as binary", async () => {
    const { root, service } = fixture();
    const content = "x".repeat(2 * 1024 * 1024);
    NodeFS.writeFileSync(NodePath.join(root, "limit.txt"), content);
    await expect(service.read("workspace-1", "limit.txt")).resolves.toEqual({ kind: "text", path: "limit.txt", size: 2097152, encoding: "utf-8", content, changedLines: null });
    NodeFS.writeFileSync(NodePath.join(root, "large.bin"), Buffer.alloc(3 * 1024 * 1024));
    await expect(service.read("workspace-1", "large.bin")).resolves.toEqual({ kind: "binary", path: "large.bin", size: 3145728 });
  });

  it.each([
    ["utf8.txt", Buffer.from([0xef, 0xbb, 0xbf, 0x61]), "utf-8", "a"],
    ["le.txt", Buffer.from([0xff, 0xfe, 0x61, 0]), "utf-16le", "a"],
    ["be.txt", Buffer.from([0xfe, 0xff, 0, 0x61]), "utf-16be", "a"],
    ["empty.txt", Buffer.alloc(0), "utf-8", ""],
  ])("decodes %s from its BOM", async (path, bytes, encoding, content) => {
    const { root, service } = fixture();
    NodeFS.writeFileSync(NodePath.join(root, path), bytes);
    await expect(service.read("workspace-1", path)).resolves.toEqual({ kind: "text", path, size: bytes.length, encoding, content, changedLines: null });
  });

  it.each([Buffer.from([65, 0, 66]), Buffer.from([0xc3, 0x28])])("detects binary bytes %j", async (bytes) => {
    const { root, service } = fixture();
    NodeFS.writeFileSync(NodePath.join(root, "data.bin"), bytes);
    await expect(service.read("workspace-1", "data.bin")).resolves.toEqual({ kind: "binary", path: "data.bin", size: bytes.length });
  });

  it("returns an encoded image URL and supports SVG source", async () => {
    const { root, service } = fixture();
    NodeFS.writeFileSync(NodePath.join(root, "a b.svg"), "<svg/>");
    await expect(service.read("workspace-1", "a b.svg", "thread-1")).resolves.toEqual({
      kind: "image", path: "a b.svg", size: 6, mime: "image/svg+xml",
      url: "/workspace-images/workspace-1?path=a+b.svg&use=file&threadId=thread-1",
    });
    await expect(service.read("workspace-1", "a b.svg", undefined, "text")).resolves.toEqual({
      kind: "text", path: "a b.svg", size: 6, encoding: "utf-8", content: "<svg/>", changedLines: null,
    });
  });

  it("caps Git listings at 100,000 paths and reports truncation", async () => {
    const paths = Array.from({ length: 100001 }, (_, i) => `file-${i}.ts`);
    const { service } = makeService({ exec: vi.fn().mockResolvedValue({ stdout: paths.join("\0") }) });
    const result = await service.list("workspace-1");
    expect(result.paths).toEqual(paths.slice(0, 100000));
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation at the exact listing cap", async () => {
    const paths = Array.from({ length: 100000 }, (_, i) => `file-${i}.ts`);
    const { service } = makeService({ exec: vi.fn().mockResolvedValue({ stdout: paths.join("\0") }) });
    const result = await service.list("workspace-1");
    expect(result.paths.length).toBe(100000);
    expect(result.paths[99999]).toBe("file-99999.ts");
    expect(result.truncated).toBe(false);
  });

  it("caps change marks after filtering deleted paths", async () => {
    const entries = Array.from({ length: 5001 }, (_, i) => `?? file-${i}.ts\0`).join("");
    const { service } = makeService({ exec: vi.fn().mockResolvedValue({ stdout: ` D gone.ts\0${entries}` }) });
    const result = await service.changes("workspace-1");
    expect(result.entries).toEqual(Array.from({ length: 5000 }, (_, i) => ({ path: `file-${i}.ts`, mark: "A" })));
    expect(result.truncated).toBe(true);
    expect(result.git).toBe(true);
  });

  it("returns no marks for a non-git folder", async () => {
    const { root } = fixture();
    const { service } = makeService({ root, exec: vi.fn().mockRejectedValue(new Error("not a repo")) });
    await expect(service.changes("workspace-1")).resolves.toEqual({ git: false, entries: [], truncated: false });
  });

  it("surfaces unexpected Git failures instead of silently removing change bars", async () => {
    const { root } = fixture();
    NodeFS.writeFileSync(NodePath.join(root, "file.txt"), "content");
    const { service } = makeService({ root, exec: vi.fn().mockRejectedValue(new Error("Git permission denied")) });
    await expect(service.read("workspace-1", "file.txt")).rejects.toThrow("Git permission denied");
  });

  it("returns null for unborn HEAD without interpreting localized diff errors", async () => {
    const { root } = fixture();
    NodeFS.writeFileSync(NodePath.join(root, "file.txt"), "content");
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === "diff") throw Object.assign(new Error("Git failed"), { code: 128, stderr: "révision HEAD inconnue" });
      if (args.includes("--verify")) throw Object.assign(new Error("Git failed"), { code: 1 });
      return { stdout: root, stderr: "" };
    });
    const { service } = makeService({ root, exec });
    await expect(service.read("workspace-1", "file.txt")).resolves.toEqual({
      kind: "text", path: "file.txt", size: 7, encoding: "utf-8", content: "content", changedLines: null,
    });
  });
});
