/**
 * Tests for FilesystemBrowser — verifies path resolution, entry listing,
 * path traversal rejection, and result truncation.
 */

import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { FilesystemBrowser } from "../services/filesystem-browser.js";

describe("FilesystemBrowser", () => {
  const browser = new FilesystemBrowser();

  it("browse returns entries and a parent for a real directory", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "fs-browse-"));
    await mkdir(join(tmp, "a_dir"));
    await writeFile(join(tmp, "b.txt"), "");
    const result = await browser.browse(tmp);
    expect(result.entries.map((e) => e.name).sort()).toEqual(["a_dir", "b.txt"]);
    expect(result.entries.find((e) => e.name === "a_dir")?.isDir).toBe(true);
    expect(result.parent).toBe(dirname(tmp));
  });

  it("browse expands ~ to home dir", async () => {
    const result = await browser.browse("~");
    expect(result.path).toBe(homedir());
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it("browse on a file returns the file's parent directory", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "fs-browse-"));
    const f = join(tmp, "x.txt");
    await writeFile(f, "");
    const result = await browser.browse(f);
    expect(result.path).toBe(tmp);
    expect(result.entries.some((e) => e.name === "x.txt")).toBe(true);
  });

  it("browse on a non-existent path walks up to nearest existing parent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "fs-browse-"));
    const result = await browser.browse(join(tmp, "ghost", "child"));
    expect(result.path).toBe(tmp);
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it("browse rejects path traversal attempts", async () => {
    await expect(browser.browse("../../etc")).rejects.toThrow();
  });

  it("browse returns at most 500 entries", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "fs-browse-big-"));
    await Promise.all(
      Array.from({ length: 600 }, (_, i) => writeFile(join(tmp, `f${i}.txt`), "")),
    );
    const result = await browser.browse(tmp);
    expect(result.entries.length).toBeLessThanOrEqual(500);
  });
});
