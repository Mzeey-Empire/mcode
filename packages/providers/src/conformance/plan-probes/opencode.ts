import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import which from "which";
import { commandOutput, type ProbeContext, type ProbeEnd } from "./runtime.js";

/** Preserve normal credentials; do not relocate the auth-containing data home. */
export async function probeOpencode(context: ProbeContext): Promise<ProbeEnd> {
  const shim = which.sync("opencode");
  const cli = NodePath.join(NodePath.dirname(shim), "node_modules/opencode-ai/bin/opencode.exe");
  const version = await commandOutput(context, cli, ["--version"]);
  context.version({ cliVersion: version, protocolVersion: "unmeasured", sdk: null });
  const help = await commandOutput(context, cli, ["serve", "--help"]);
  NodeFS.writeFileSync(NodePath.join(context.rawDirectory, "help.txt"), help);
  throw new Error("OpenCode serve help does not expose separate plan/session storage while preserving normal data-home authentication; live request blocked pending safe override");
}
