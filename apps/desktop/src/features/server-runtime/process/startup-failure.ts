import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  describeRefusal,
  STARTUP_FAILURE_FILE_MAX_BYTES,
  STARTUP_FAILURE_FILE_NAME,
  StartupFailureFileSchema,
  type StartupRefusal,
} from "@mcode/contracts";

/** The server started, found it must not open the user's data, and said why. */
export class ServerStartupRefusedError extends Error {
  override readonly name = "ServerStartupRefusedError";

  constructor(readonly refusal: StartupRefusal) {
    super(describeRefusal(refusal));
  }
}

/** The file is read only when its size is within the limit, so a huge file never reaches memory. */
function readFailureText(path: string): string | null {
  try {
    if (NodeFS.statSync(path).size > STARTUP_FAILURE_FILE_MAX_BYTES) {
      console.warn("[server-manager] Ignoring oversized startup-failure.json");
      return null;
    }
    return NodeFS.readFileSync(path, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    console.warn("[server-manager] Could not read startup-failure.json", error);
    return null;
  }
}

function parseFailureText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.warn("[server-manager] Ignoring unparseable startup-failure.json", error);
    return undefined;
  }
}

/**
 * The refusal the server recorded for this spawn, or null when there is none worth trusting.
 * The file sits in a directory other processes can write to, so it counts only when it parses
 * against the contract and names the `startupId` this process spawned the server with.
 */
export function readStartupRefusal(dataDir: string, startupId: string): StartupRefusal | null {
  const text = readFailureText(NodePath.join(dataDir, STARTUP_FAILURE_FILE_NAME));
  if (text === null) return null;
  const json = parseFailureText(text);
  if (json === undefined) return null;
  const parsed = StartupFailureFileSchema().safeParse(json);
  if (!parsed.success) {
    console.warn("[server-manager] Ignoring startup-failure.json that does not match the contract");
    return null;
  }
  if (parsed.data.startupId !== startupId) return null;
  return "refusal" in parsed.data ? parsed.data.refusal : null;
}
