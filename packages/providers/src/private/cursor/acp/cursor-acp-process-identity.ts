import * as NodeCrypto from "node:crypto";
import { getCatalogEntry } from "@mcode/contracts/providers/catalog";
import { type Settings } from "@mcode/contracts/models/settings";
import { buildCursorAcpArgs } from "./cursor-acp-spawn-args.js";

/** Returns a bounded fingerprint of Cursor settings that affect ACP subprocess creation. */
export function cursorAcpProcessIdentity(
  settings: Settings,
  permissionMode: "default" | "full",
  platform: NodeJS.Platform,
): string {
  const configuredCli = settings.provider.cli.cursor?.trim();
  const cliCandidates = configuredCli ? [configuredCli] : [getCatalogEntry("cursor").cliBinary, "agent"];
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ cliCandidates, args: buildCursorAcpArgs({ permissionMode, platform }) }))
    .digest("hex");
}
