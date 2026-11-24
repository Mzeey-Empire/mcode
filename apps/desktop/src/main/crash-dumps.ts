import type { CrashReporterStartOptions } from "electron";

/**
 * Returns local-only crash reporter options for development builds, or null
 * when the build must not start the crash reporter.
 *
 * A deliberate Chromium crash, such as a failed internal check, can exit with
 * 0x80000003 and no message. Development dumps stay in the Crashpad folder
 * under userData. Installed builds keep no dumps because dumps can hold process
 * memory, including conversation text and tokens.
 */
export function crashDumpOptions(isPackaged: boolean): CrashReporterStartOptions | null {
  if (isPackaged) {
    return null;
  }

  return { uploadToServer: false };
}
