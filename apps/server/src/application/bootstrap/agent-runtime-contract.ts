import * as NodeFS from "node:fs";

/** Publishes one listening endpoint for desktop discovery and agent runtime readiness. */
export function publishServerEndpoint({
  lockPath,
  contractPath,
  port,
  authToken,
  singleInstance,
  pid,
  version,
  ipcPath,
}: {
  lockPath: string;
  contractPath?: string;
  port: number;
  authToken: string;
  singleInstance: boolean;
  pid: number;
  version: string;
  ipcPath: string;
}): { lockError: string | null; contractError: string | null } {
  let lockError: string | null = null;
  let contractError: string | null = null;
  try {
    const lockData = JSON.stringify({
      port,
      ...(!singleInstance && { authToken }),
      pid,
      startedAt: new Date().toISOString(),
      version,
      ipcPath,
    });
    NodeFS.writeFileSync(lockPath, lockData, { mode: 0o600 });
  } catch (error) {
    lockError = String(error);
  }
  if (contractPath) {
    try {
      publishAgentRuntimeEndpoint(contractPath, port, authToken);
    } catch (error) {
      contractError = String(error);
    }
  }
  return { lockError, contractError };
}

/** Publishes the listening endpoint to the contract owned by this server's auth token. */
export function publishAgentRuntimeEndpoint(path: string, port: number, authToken: string): void {
  const stats = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile()) return;

  const contents = NodeFS.readFileSync(path, "utf8");
  let contract: { seedLogin?: { token?: unknown }; serverPort?: number; healthUrl?: string } | null;
  try {
    contract = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  if (contract?.seedLogin?.token !== authToken) return;

  contract.serverPort = port;
  contract.healthUrl = `http://127.0.0.1:${port}/health`;
  const tempPath = `${path}.tmp`;
  // An interrupted server startup can leave its unpublished file behind.
  NodeFS.rmSync(tempPath, { force: true });
  NodeFS.writeFileSync(tempPath, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    NodeFS.renameSync(tempPath, path);
  } catch (error) {
    NodeFS.rmSync(tempPath, { force: true });
    throw error;
  }
}
