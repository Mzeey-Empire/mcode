import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { rawGit, rawPath, readRawStates, absentState, type RawPathState } from "./snapshot-raw-state.js";
import { PIN_COMMIT_ENV, type StoreId } from "./snapshot-store-identity.js";

/** Git tree entry for preview classification only. */
export interface SnapshotBlob { blob: string; mode: string }

/** Allocate isolated Git plumbing under this worktree's own Git directory. */
export async function withSnapshotIndex<T>(cwd: string, work: (env: NodeJS.ProcessEnv, scratch: string) => Promise<T>, id: string = NodeCrypto.randomUUID()): Promise<T> {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid snapshot operation id");
  const location = (await rawGit(cwd, ["rev-parse", "--git-path", `mcode-revert-${id}`])).toString().trim();
  const scratch = NodePath.resolve(cwd, location);
  await NodeFSPromises.mkdir(scratch, { recursive: true });
  try { return await work({ ...process.env, GIT_INDEX_FILE: NodePath.join(scratch, "index") }, scratch); }
  finally { await NodeFSPromises.rm(scratch, { recursive: true, force: true }); }
}

/** Read literal paths from a tree, including directory and gitlink entries. */
export async function blobIdsAt(cwd: string, ref: string, paths: readonly string[], batches: string[][]): Promise<Map<string, SnapshotBlob | null>> {
  const result = new Map<string, SnapshotBlob | null>(paths.map((name) => [name, null]));
  for (const batch of batches) {
    const output = await rawGit(cwd, ["ls-tree", "-z", ref, "--", ...batch]);
    for (const record of output.toString().split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      const [mode, , blob] = record.slice(0, tab).split(" ");
      const name = record.slice(tab + 1);
      if (mode && blob && result.has(name)) result.set(name, { mode, blob });
    }
  }
  return result;
}

/** Build planned checkout bytes without writing any path in the working tree. */
export async function planCheckout(cwd: string, ref: string, operationId: string, paths: readonly string[], blobs: Map<string, SnapshotBlob | null>, fileMode: boolean): Promise<Map<string, RawPathState>> {
  return withSnapshotIndex(cwd, async (env, scratch) => {
    await rawGit(cwd, ["read-tree", ref], undefined, env);
    const staging = NodePath.join(scratch, "checkout");
    await NodeFSPromises.mkdir(staging);
    const files = paths.filter((name) => { const mode = blobs.get(name)?.mode; return mode && mode !== "040000" && mode !== "160000"; });
    if (files.length) await rawGit(cwd, ["checkout-index", `--prefix=${staging.replaceAll("\\", "/")}/`, "-z", "--stdin"], `${files.join("\0")}\0`, env);
    const states = await readRawStates(staging, paths, fileMode, cwd);
    for (const name of paths) {
      rawPath(cwd, name);
      if (blobs.get(name)?.mode === "040000") states.set(name, { ...absentState(), kind: "directory" });
    }
    return states;
  }, operationId);
}

/** Keep every raw pre and planned blob reachable using the store's fixed commit identity. */
export async function pinRecovery(cwd: string, storeId: StoreId, operationId: string, states: readonly RawPathState[]): Promise<string> {
  const lines = states.flatMap((state, index) => state.rawBlob ? [`100644 blob ${state.rawBlob}\t${index}\n`] : []);
  const tree = (await rawGit(cwd, ["mktree"], lines.join(""))).toString().trim();
  const commit = (await rawGit(cwd, ["commit-tree", tree, "-m", "mcode revert recovery"], undefined, PIN_COMMIT_ENV)).toString().trim();
  const ref = `refs/mcode/${storeId}/reverts/${operationId}`;
  await rawGit(cwd, ["update-ref", ref, commit]);
  return ref;
}
