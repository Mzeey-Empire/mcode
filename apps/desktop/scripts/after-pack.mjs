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
  // Step 1: V8 snapshot copy + fuse flip (skip if snapshot not generated)
  // -------------------------------------------------------------------------

  if (!existsSync(snapshotFile)) {
    console.log("[after-pack] No snapshot found, skipping fuse configuration");
  } else {
    let snapshotDest;
    let electronBinary;

    if (electronPlatformName === "darwin") {
      const frameworkDir = join(
        appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents/Frameworks/Electron Framework.framework/Resources",
      );
      snapshotDest = join(frameworkDir, "browser_v8_context_snapshot.bin");
      electronBinary = join(
        appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents/Frameworks/Electron Framework.framework/Electron Framework",
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
      resetAdHocDarwinSignature: electronPlatformName === "darwin",
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
    });

    console.log("[after-pack] V8 snapshot fuse enabled");
  }

  // -------------------------------------------------------------------------
  // Step 2: Produce renamed server binary (runs after fuse flip so the copy
  // inherits the already-flipped state byte-for-byte).
  // -------------------------------------------------------------------------

  const productFilename =
    context.packager.appInfo.productFilename ??
    context.packager.appInfo.productName;
  // electron-builder gives "1.2.3"; pad to dotted quad for Windows VERSIONINFO.
  const appVersion = `${context.packager.appInfo.version}.0`;
  const companyName = context.packager.appInfo.companyName ?? "Mcode";

  await buildServerBinary({
    appOutDir: context.appOutDir,
    electronPlatformName,
    productFilename,
    appVersion,
    companyName,
  });

  console.log("[after-pack] Built renamed server binary");
}
