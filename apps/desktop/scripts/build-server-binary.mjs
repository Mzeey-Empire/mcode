import { copyFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve where the Electron binary lives in the packaged output and
 * where the renamed copy should be written, per platform.
 *
 * @param {object} args
 * @param {string} args.appOutDir - electron-builder afterPack appOutDir.
 * @param {"win32"|"darwin"|"linux"|"mas"|string} args.electronPlatformName
 * @param {string} args.productFilename - filename (no extension) of the main app binary.
 * @returns {{ srcBinary: string, dstBinary: string }}
 */
export function resolveBinaryPaths({ appOutDir, electronPlatformName, productFilename }) {
  if (electronPlatformName === "win32") {
    return {
      srcBinary: path.join(appOutDir, `${productFilename}.exe`),
      dstBinary: path.join(appOutDir, "resources", "bin", "mcode-server.exe"),
    };
  }
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    const appBundle = path.join(appOutDir, `${productFilename}.app`);
    return {
      srcBinary: path.join(appBundle, "Contents", "MacOS", productFilename),
      dstBinary: path.join(appBundle, "Contents", "Resources", "bin", "mcode-server"),
    };
  }
  // linux and any other Unix
  return {
    srcBinary: path.join(appOutDir, productFilename),
    dstBinary: path.join(appOutDir, "resources", "bin", "mcode-server"),
  };
}

/**
 * Copy the Electron binary to a renamed location so the spawned server
 * shows up as "mcode-server" / "Mcode Server" in process viewers.
 * Windows VERSIONINFO stamping is added in a follow-up task.
 *
 * @param {object} args
 * @param {string} args.appOutDir
 * @param {"win32"|"darwin"|"linux"|"mas"|string} args.electronPlatformName
 * @param {string} args.productFilename
 */
export async function buildServerBinary({ appOutDir, electronPlatformName, productFilename }) {
  const { srcBinary, dstBinary } = resolveBinaryPaths({
    appOutDir,
    electronPlatformName,
    productFilename,
  });
  await mkdir(path.dirname(dstBinary), { recursive: true });
  await copyFile(srcBinary, dstBinary);
  if (process.platform !== "win32") {
    await chmod(dstBinary, 0o755);
  }
}
