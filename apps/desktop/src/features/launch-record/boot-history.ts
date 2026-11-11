import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";

// The boot time is the wall clock minus uptime, and the two drift apart slightly between launches of one boot.
const SAME_BOOT_TOLERANCE_MS = 5_000;

/**
 * Stores this launch's boot time and compares it with the one the previous launch stored. Resolves true for the
 * first launch since boot, false for a later one, and null when no previous launch left a readable boot time.
 */
export async function classifyLaunchBoot(path: string, bootAt: number): Promise<boolean | null> {
  const previous = await readPreviousBoot(path);
  // The first launch after install classifies its boot before Electron creates the user-data directory.
  await NodeFSPromises.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSPromises.writeFile(path, JSON.stringify(bootAt));
  return previous === null ? null : Math.abs(previous - bootAt) > SAME_BOOT_TOLERANCE_MS;
}

async function readPreviousBoot(path: string): Promise<number | null> {
  let text: string;
  try {
    text = await NodeFSPromises.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
