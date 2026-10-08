import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { commandOutput, type ProbeContext, type ProbeEnd } from "./runtime.js";

/** Discover only the installed Windows launcher; no install or unsafe plan turn. */
export async function probeCursor(context: ProbeContext): Promise<ProbeEnd> {
  const directory = NodePath.join(NodeOS.homedir(), "AppData/Local/cursor-agent/versions");
  const versions = NodeFS.readdirSync(directory).filter((name) => /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$/.test(name)).sort().reverse();
  const version = versions[0];
  if (!version) throw new Error("Cursor CLI not runnable in the permitted discovery directory");
  const cli = NodePath.join(directory, version);
  const env = { NODE_COMPILE_CACHE: NodePath.join(context.providerHome, "cache") };
  const child = context.spawn(NodePath.join(cli, "node.exe"), [NodePath.join(cli, "index.js"), "--help"], env);
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Cursor help exited ${code}`))); });
  NodeFS.writeFileSync(NodePath.join(context.rawDirectory, "help.txt"), Buffer.concat(output));
  const exact = await commandOutput(context, NodePath.join(cli, "node.exe"), [NodePath.join(cli, "index.js"), "--version"]);
  context.version({ cliVersion: exact, protocolVersion: "unmeasured", sdk: null });
  throw new Error("Cursor help does not establish a plan-directory override or write interception for native create_plan; live plan probing blocked by containment requirement");
}
