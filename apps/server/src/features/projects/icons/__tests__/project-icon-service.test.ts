import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Workspace } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../testing/owned-test-database.js";
import { ProjectIconService } from "../project-icon-service.js";

let temp: string;
let root: string;
let database: OwnedTestDatabase;
let repo: WorkspaceRepo;
let workspace: Workspace;
let now: number;
let service: ProjectIconService;

beforeEach(async () => {
  temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-project-icon-"));
  root = NodePath.join(temp, "project");
  NodeFS.mkdirSync(root);
  database = createOwnedTestDatabase();
  repo = new WorkspaceRepo(database.db, database.writer);
  workspace = await repo.create("project", root, true);
  now = 1_000;
  service = new ProjectIconService({ workspaces: repo, platform: process.platform, now: () => now });
});

afterEach(async () => {
  await database.close();
  NodeFS.rmSync(temp, { recursive: true, force: true });
});

function write(relativePath: string, content: string | Buffer = "<svg/>"): void {
  const fullPath = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(fullPath), { recursive: true });
  NodeFS.writeFileSync(fullPath, content);
}

async function resolveOne() {
  const [icon] = await service.resolve([workspace.id]);
  return icon;
}

function expireCache(): void {
  now += 60_001;
}

describe("ProjectIconService.resolve", () => {
  it("prefers the chosen file over a detected favicon", async () => {
    write("public/favicon.svg");
    write("brand/mark.png", "png");
    const icon = await service.set(workspace.id, "brand/mark.png");
    expect(icon).toMatchObject({ workspaceId: workspace.id, source: "chosen", path: "brand/mark.png", chosenMissing: false });
    expect(repo.findById(workspace.id)?.icon_path).toBe("brand/mark.png");
    expect(await resolveOne()).toMatchObject({ source: "chosen", path: "brand/mark.png" });
  });

  it("falls back to automatic and reports a missing chosen file", async () => {
    write("public/favicon.svg");
    write("brand/mark.png", "png");
    await service.set(workspace.id, "brand/mark.png");
    NodeFS.rmSync(NodePath.join(root, "brand/mark.png"));
    expireCache();
    expect(await resolveOne()).toMatchObject({ source: "automatic", path: "public/favicon.svg", chosenMissing: true });
  });

  it("detects public/favicon.svg and shows the monogram once it is removed and the cache expires", async () => {
    write("public/favicon.svg");
    expect(await resolveOne()).toMatchObject({ source: "automatic", path: "public/favicon.svg", chosenMissing: false });
    NodeFS.rmSync(NodePath.join(root, "public/favicon.svg"));
    expect(await resolveOne()).toMatchObject({ source: "automatic", path: "public/favicon.svg" });
    expireCache();
    expect(await resolveOne()).toEqual({ workspaceId: workspace.id, source: "none", chosenMissing: false });
  });

  it("drops the cache entry when the icon is set", async () => {
    expect(await resolveOne()).toMatchObject({ source: "none" });
    write("logo.svg");
    expect(await resolveOne()).toMatchObject({ source: "none" });
    expect(await service.set(workspace.id, null)).toMatchObject({ source: "automatic", path: "logo.svg" });
  });

  it("follows a site-absolute link icon in index.html to public/", async () => {
    write("index.html", `<head><link href='/brand.svg?v=3' type="image/svg+xml" rel="icon"></head>`);
    write("public/brand.svg");
    expect(await resolveOne()).toMatchObject({ source: "automatic", path: "public/brand.svg" });
  });

  it("resolves a relative shortcut icon against the HTML file's folder", async () => {
    write("src/index.html", `<link rel="shortcut icon" href="./img/fav.png#x">`);
    write("src/img/fav.png", "png");
    expect(await resolveOne()).toMatchObject({ source: "automatic", path: "src/img/fav.png" });
  });

  it("ignores remote, protocol-relative and data hrefs", async () => {
    write("brand.svg");
    write("index.html", [
      `<link rel="icon" href="https://cdn.example.com/brand.svg">`,
      `<link rel="icon" href="http://cdn.example.com/brand.svg">`,
      `<link rel="icon" href="//cdn.example.com/brand.svg">`,
      `<link rel="icon" href="data:image/svg+xml,<svg/>">`,
    ].join("\n"));
    expect(await resolveOne()).toEqual({ workspaceId: workspace.id, source: "none", chosenMissing: false });
  });

  it("skips a detected favicon larger than the icon cap", async () => {
    write("favicon.png", Buffer.alloc(2 * 1024 * 1024 + 1));
    write("public/logo.png", "png");
    expect(await resolveOne()).toMatchObject({ source: "automatic", path: "public/logo.png" });
  });

  it("omits unknown workspace ids", async () => {
    expect(await service.resolve(["missing-workspace", workspace.id])).toEqual([
      { workspaceId: workspace.id, source: "none", chosenMissing: false },
    ]);
  });
});

describe("ProjectIconService.set", () => {
  const escapeSupported = (() => {
    const probe = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-icon-link-"));
    try {
      NodeFS.symlinkSync(NodeOS.tmpdir(), NodePath.join(probe, "link"), "junction");
      return true;
    } catch {
      return false;
    } finally {
      NodeFS.rmSync(probe, { recursive: true, force: true });
    }
  })();

  it.each([
    ["parent traversal", "../outside.svg"],
    ["POSIX absolute", "/x.svg"],
    ["drive letter", "C:/x.svg"],
    ["UNC", "\\\\server\\share\\x.svg"],
    ["backslash", "a\\b.svg"],
    ["executable", "tool.exe"],
    ["over 2 MB", "huge.png"],
  ])("rejects a %s path and keeps the stored icon", async (_label, iconPath) => {
    write("a/b.svg");
    write("tool.exe", "MZ");
    write("huge.png", Buffer.alloc(2 * 1024 * 1024 + 1));
    NodeFS.writeFileSync(NodePath.join(temp, "outside.svg"), "<svg/>");
    await expect(service.set(workspace.id, iconPath)).rejects.toMatchObject({ code: "invalid_icon_path" });
    expect(repo.findById(workspace.id)?.icon_path).toBeNull();
  });

  it("rejects an absolute host path to a file inside the project", async () => {
    write("logo.svg");
    await expect(service.set(workspace.id, NodePath.join(root, "logo.svg"))).rejects.toMatchObject({ code: "invalid_icon_path" });
  });

  it.skipIf(!escapeSupported)("rejects a symlink that escapes the project", async () => {
    const outside = NodePath.join(temp, "outside");
    NodeFS.mkdirSync(outside);
    NodeFS.writeFileSync(NodePath.join(outside, "secret.svg"), "<svg/>");
    NodeFS.symlinkSync(outside, NodePath.join(root, "escape"), "junction");
    await expect(service.set(workspace.id, "escape/secret.svg")).rejects.toMatchObject({ code: "invalid_icon_path" });
    expect(repo.findById(workspace.id)?.icon_path).toBeNull();
  });

  it("stores an upper-case allowed extension and clears back to automatic", async () => {
    write("Brand/Logo.SVG");
    expect(await service.set(workspace.id, "Brand/Logo.SVG")).toMatchObject({ source: "chosen", path: "Brand/Logo.SVG" });
    expect(await service.set(workspace.id, null)).toEqual({ workspaceId: workspace.id, source: "none", chosenMissing: false });
    expect(repo.findById(workspace.id)?.icon_path).toBeNull();
  });

  it("reports an unknown workspace", async () => {
    await expect(service.set("missing-workspace", null)).rejects.toMatchObject({ code: "workspace_not_found" });
  });
});

describe("project icon URLs", () => {
  function fixedService(id: string): ProjectIconService {
    const fixed: Workspace = { ...workspace, id, icon_path: null };
    return new ProjectIconService({
      workspaces: { findById: (candidate) => (candidate === id ? fixed : null), setIconPath: async () => null },
      platform: process.platform,
      now: () => now,
    });
  }

  it("builds the image route URL with the encoded workspace id, icon use and version", async () => {
    write("public/favicon.svg", "<svg/>");
    NodeFS.utimesSync(NodePath.join(root, "public/favicon.svg"), 1_700_000_000, 1_700_000_000);
    const [icon] = await fixedService("ws 1/a").resolve(["ws 1/a"]);
    expect(icon).toEqual({
      workspaceId: "ws 1/a",
      source: "automatic",
      chosenMissing: false,
      path: "public/favicon.svg",
      version: "4739de4dbbd4c0e0",
      url: "/workspace-images/ws%201%2Fa?path=public%2Ffavicon.svg&use=icon&v=4739de4dbbd4c0e0",
    });
  });

  it("changes the version and URL when the file content changes", async () => {
    write("logo.svg", "<svg/>");
    const first = await resolveOne();
    write("logo.svg", "<svg><rect/></svg>");
    expireCache();
    const second = await resolveOne();
    expect(first).toMatchObject({ path: "logo.svg" });
    expect(second).toMatchObject({ path: "logo.svg" });
    if (first?.source !== "automatic" || second?.source !== "automatic") throw new Error("expected automatic icons");
    expect(second.version).not.toBe(first.version);
    expect(second.url).toBe(`/workspace-images/${workspace.id}?path=logo.svg&use=icon&v=${second.version}`);
    expect(second.url).not.toBe(first.url);
  });
});
