import { copyFile, mkdir, chmod, readFile, writeFile } from "node:fs/promises";
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
  if (!productFilename || typeof productFilename !== "string") {
    throw new Error(
      `resolveBinaryPaths: productFilename is required (got ${productFilename === undefined ? "undefined" : JSON.stringify(productFilename)})`,
    );
  }
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
 * Stamp Windows VERSIONINFO on an existing PE file using resedit.
 * Task Manager's "Name" column reads FileDescription, so this is what makes
 * the renamed binary show up as "Mcode Server" instead of "Electron".
 *
 * @param {string} exePath - absolute path to the .exe to modify in place
 * @param {object} info
 * @param {string} info.fileDescription
 * @param {string} info.productName
 * @param {string} info.companyName
 * @param {string} info.fileVersion - dotted quad e.g. "1.2.3.0"
 * @param {string} info.productVersion - dotted quad
 * @param {string} info.originalFilename
 * @returns {Promise<void>}
 */
export async function stampWindowsVersionInfo(exePath, info) {
  const { NtExecutable, NtExecutableResource, Resource } = await import("resedit");
  const buf = await readFile(exePath);
  const exe = NtExecutable.from(buf);
  const res = NtExecutableResource.from(exe);

  const versionInfo = Resource.VersionInfo.createEmpty();
  versionInfo.setFileVersion(info.fileVersion);
  versionInfo.setProductVersion(info.productVersion);
  versionInfo.setStringValues(
    { lang: 1033, codepage: 1200 }, // en-US, Unicode
    {
      FileDescription: info.fileDescription,
      ProductName: info.productName,
      CompanyName: info.companyName,
      OriginalFilename: info.originalFilename,
      InternalName: info.originalFilename,
    },
  );
  versionInfo.outputToResourceEntries(res.entries);
  res.outputResource(exe);

  await writeFile(exePath, Buffer.from(exe.generate()));
}

/**
 * Copy the Electron binary to a renamed location so the spawned server
 * shows up as "mcode-server" / "Mcode Server" in process viewers.
 * On Windows, also stamps VERSIONINFO so Task Manager shows "Mcode Server"
 * in the Name column instead of "Electron".
 *
 * @param {object} args
 * @param {string} args.appOutDir
 * @param {"win32"|"darwin"|"linux"|"mas"|string} args.electronPlatformName
 * @param {string} args.productFilename
 * @param {string} [args.appVersion] - dotted quad like "1.2.3.0"; required on win32
 * @param {string} [args.companyName] - default "Mcode"
 */
export async function buildServerBinary({
  appOutDir,
  electronPlatformName,
  productFilename,
  appVersion,
  companyName = "Mcode",
}) {
  const { srcBinary, dstBinary } = resolveBinaryPaths({
    appOutDir,
    electronPlatformName,
    productFilename,
  });
  await mkdir(path.dirname(dstBinary), { recursive: true });
  await copyFile(srcBinary, dstBinary);
  if (electronPlatformName !== "win32") {
    await chmod(dstBinary, 0o755);
  }
  if (electronPlatformName === "win32") {
    if (!appVersion) {
      throw new Error(
        "buildServerBinary: appVersion is required when electronPlatformName is win32",
      );
    }
    // VERSIONINFO numeric fields require a dotted quad of integers, each
    // bounded to 16 bits (HIWORD/LOWORD of dwFileVersionMS/LS). Catch upstream
    // callers that forgot to normalize semver prerelease suffixes or that
    // produced out-of-range values, before they reach resedit (which clamps
    // silently and would emit a corrupted resource).
    const isDottedQuad = /^\d+\.\d+\.\d+\.\d+$/.test(appVersion);
    const segmentsInRange =
      isDottedQuad &&
      appVersion.split(".").every((part) => {
        const n = Number(part);
        return Number.isInteger(n) && n >= 0 && n <= 65535;
      });
    if (!segmentsInRange) {
      throw new Error(
        `buildServerBinary: appVersion must be a numeric dotted quad with each segment in [0, 65535] on win32 (got ${JSON.stringify(appVersion)})`,
      );
    }
    await stampWindowsVersionInfo(dstBinary, {
      fileDescription: "Mcode Server",
      productName: "Mcode Server",
      companyName,
      fileVersion: appVersion,
      productVersion: appVersion,
      originalFilename: "mcode-server.exe",
    });
  }
}
