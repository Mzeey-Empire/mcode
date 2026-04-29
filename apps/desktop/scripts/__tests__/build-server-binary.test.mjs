import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildServerBinary, resolveBinaryPaths } from "../build-server-binary.mjs";

describe("resolveBinaryPaths", () => {
  it("Windows: copies <Product>.exe to resources\\bin\\mcode-server.exe", () => {
    const result = resolveBinaryPaths({
      appOutDir: "C:\\dist\\win-unpacked",
      electronPlatformName: "win32",
      productFilename: "Mcode",
    });
    expect(result.srcBinary).toBe(path.join("C:\\dist\\win-unpacked", "Mcode.exe"));
    expect(result.dstBinary).toBe(
      path.join("C:\\dist\\win-unpacked", "resources", "bin", "mcode-server.exe"),
    );
  });

  it("macOS: copies <Product>.app/Contents/MacOS/<Product> to Contents/Resources/bin/mcode-server", () => {
    const result = resolveBinaryPaths({
      appOutDir: "/dist/mac",
      electronPlatformName: "darwin",
      productFilename: "MCode",
    });
    expect(result.srcBinary).toBe("/dist/mac/MCode.app/Contents/MacOS/MCode");
    expect(result.dstBinary).toBe(
      "/dist/mac/MCode.app/Contents/Resources/bin/mcode-server",
    );
  });

  it("mas (Mac App Store) treated like darwin", () => {
    const result = resolveBinaryPaths({
      appOutDir: "/dist/mas",
      electronPlatformName: "mas",
      productFilename: "MCode",
    });
    expect(result.srcBinary).toBe("/dist/mas/MCode.app/Contents/MacOS/MCode");
    expect(result.dstBinary).toBe(
      "/dist/mas/MCode.app/Contents/Resources/bin/mcode-server",
    );
  });

  it("Linux: copies <appOutDir>/<exe> to <appOutDir>/resources/bin/mcode-server", () => {
    const result = resolveBinaryPaths({
      appOutDir: "/dist/linux-unpacked",
      electronPlatformName: "linux",
      productFilename: "mcode",
    });
    expect(result.srcBinary).toBe("/dist/linux-unpacked/mcode");
    expect(result.dstBinary).toBe("/dist/linux-unpacked/resources/bin/mcode-server");
  });
});

describe("buildServerBinary (copy + chmod)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "build-server-binary-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("copies the source binary to the destination and makes it executable on Unix", async () => {
    const srcBinary = path.join(tmpDir, "mcode");
    await writeFile(srcBinary, "#!/usr/bin/env true\n", { mode: 0o755 });

    await buildServerBinary({
      appOutDir: tmpDir,
      electronPlatformName: "linux",
      productFilename: "mcode",
    });

    const dst = path.join(tmpDir, "resources", "bin", "mcode-server");
    const dstContents = await readFile(dst);
    const srcContents = await readFile(srcBinary);
    expect(dstContents.equals(srcContents)).toBe(true);

    if (process.platform !== "win32") {
      const stats = await stat(dst);
      expect(stats.mode & 0o100).toBeTruthy();
    }
  });

  it("creates the destination directory if it does not exist", async () => {
    const srcBinary = path.join(tmpDir, "mcode");
    await writeFile(srcBinary, "x", { mode: 0o755 });

    await buildServerBinary({
      appOutDir: tmpDir,
      electronPlatformName: "linux",
      productFilename: "mcode",
    });

    const dst = path.join(tmpDir, "resources", "bin", "mcode-server");
    const dstStat = await stat(dst);
    expect(dstStat.isFile()).toBe(true);
  });
});
