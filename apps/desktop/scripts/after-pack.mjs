/**
 * electron-builder afterPack hook.
 *
 * 1. Copies browser_v8_context_snapshot.bin into the packaged app resources
 * 2. Flips the LoadBrowserProcessSpecificV8Snapshot fuse on the Electron binary
 *
 * This script is invoked automatically by electron-builder via the
 * "afterPack" config in package.json.
 */

import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { copyFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildServerBinary } from "./build-server-binary.mjs";

/**
 * @param {import("electron-builder").AfterPackContext} context
 */
export default async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context;
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const snapshotFile = resolve(
    desktopRoot,
    "dist/snapshot/browser_v8_context_snapshot.bin",
  );

  // -------------------------------------------------------------------------
  // Step 1: Produce renamed server binary BEFORE the fuse flip. The server
  // binary runs with ELECTRON_RUN_AS_NODE=1 and must NOT have the browser
  // V8 snapshot fuse enabled, otherwise it crashes trying to load a snapshot
  // file that isn't alongside it.
  // -------------------------------------------------------------------------

  const productFilename =
    context.packager.appInfo.productFilename ??
    context.packager.appInfo.productName;
  // Windows VERSIONINFO requires a numeric dotted quad (x.x.x.x) where each
  // segment fits in [0, 65535]. Parse only the semver core (major.minor.patch)
  // and derive a bounded fourth segment from the prerelease metadata. Nightly
  // versions like "0.11.1-nightly.20260518.42" contain a date segment that
  // exceeds 65535, so we use the run number (last prerelease segment) instead.
  const rawVersion = context.packager.appInfo.version;
  const semverCore = rawVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  const [major, minor, patch] = semverCore
    ? [semverCore[1], semverCore[2], semverCore[3]]
    : ["0", "0", "0"];
  // Extract the last numeric segment from the prerelease suffix (typically the
  // CI run number), clamped to 65535 so it always fits VERSIONINFO.
  const prerelease = rawVersion.replace(/^\d+\.\d+\.\d+[-.]?/, "");
  const preNums = prerelease.match(/\d+/g);
  const fourth = preNums
    ? String(Math.min(Number(preNums[preNums.length - 1]), 65535))
    : "0";
  const appVersion = `${major}.${minor}.${patch}.${fourth}`;
  const companyName = context.packager.appInfo.companyName ?? "Mcode";

  // The renamed copy at Contents/Resources/bin/mcode-server is co-signed by
  // electron-builder via the `mac.binaries` entry in package.json, so it
  // passes notarytool when notarization is enabled.
  await buildServerBinary({
    appOutDir: context.appOutDir,
    electronPlatformName,
    productFilename,
    executableName: context.packager.executableName,
    appVersion,
    companyName,
  });

  console.log("[after-pack] Built renamed server binary");

  // -------------------------------------------------------------------------
  // Step 2: V8 snapshot copy + fuse flip (skip if snapshot not generated).
  // This runs AFTER the server binary copy so only the main Electron binary
  // (used for the GUI) gets the fuse — not the ELECTRON_RUN_AS_NODE copy.
  // -------------------------------------------------------------------------

  if (!existsSync(snapshotFile)) {
    console.log("[after-pack] No snapshot found, skipping fuse configuration");
  } else {
    let snapshotDest;
    let electronBinary;

    if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
      const frameworkDir = join(
        appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents/Frameworks/Electron Framework.framework/Resources",
      );
      snapshotDest = join(frameworkDir, "browser_v8_context_snapshot.bin");
      // @electron/fuses expects the main executable, not the framework binary.
      // It resolves to the framework internally; passing the framework path
      // causes double Frameworks/ resolution (ENOENT).
      electronBinary = join(
        appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents", "MacOS", context.packager.appInfo.productFilename,
      );
    } else if (electronPlatformName === "win32") {
      snapshotDest = join(appOutDir, "browser_v8_context_snapshot.bin");
      electronBinary = join(
        appOutDir,
        `${context.packager.appInfo.productFilename}.exe`,
      );
    } else {
      snapshotDest = join(appOutDir, "browser_v8_context_snapshot.bin");
      electronBinary = join(appOutDir, context.packager.executableName);
    }

    console.log(`[after-pack] Copying snapshot to ${snapshotDest}`);
    copyFileSync(snapshotFile, snapshotDest);

    console.log(`[after-pack] Flipping V8 snapshot fuse on ${electronBinary}`);
    await flipFuses(electronBinary, {
      version: FuseVersion.V1,
      // On ARM64 macOS, flipping fuses invalidates the ad-hoc code signature.
      // Reset it so the binary can launch before electron-builder codesigns.
      resetAdHocDarwinSignature: electronPlatformName === "darwin" || electronPlatformName === "mas",
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
    });

    console.log("[after-pack] V8 snapshot fuse enabled");
  }
}
