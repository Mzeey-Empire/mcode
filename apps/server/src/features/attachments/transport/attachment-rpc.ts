import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { getExtension, type WsMethodName, WS_METHODS } from "@mcode/contracts";
import type { z } from "zod";
import type { AttachmentService } from "../storage/attachment-service.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";

type AttachmentRpcMethod = "clipboard.saveFile" | "attachments.stageDraft";

type AttachmentRpcParamsByMethod = {
  [Method in AttachmentRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

/** Services the attachment RPC family needs from the router. */
export interface AttachmentRouterDeps {
  attachmentService: Pick<AttachmentService, "stageDraft">;
  threadRepo: Pick<ThreadRepo, "findById">;
  workspaceRepo: Pick<WorkspaceRepo, "findById">;
}

type AttachmentHandlerMap = {
  [Method in AttachmentRpcMethod]: (
    params: AttachmentRpcParamsByMethod[Method],
    deps: AttachmentRouterDeps,
  ) => Promise<unknown> | unknown;
};

const attachmentHandlers: AttachmentHandlerMap = {
  // JSON-RPC remains available for clients that cannot upload a binary frame.
  "clipboard.saveFile": saveClipboardFile,
  "attachments.stageDraft": ({ threadId, attachment }, deps) => {
    // A new-thread draft has no thread row yet, so its images stage under the workspace id.
    const thread = deps.threadRepo.findById(threadId);
    const ownerExists = thread
      ? thread.deleted_at == null
      : deps.workspaceRepo.findById(threadId) != null;
    if (!ownerExists) throw new Error("Draft image owner does not exist");
    return deps.attachmentService.stageDraft(threadId, attachment);
  },
};

/** Checks whether a method belongs to the attachment RPC family. */
export function isAttachmentRpcMethod(method: WsMethodName): method is AttachmentRpcMethod {
  return Object.hasOwn(attachmentHandlers, method);
}

/** Routes validated attachment RPC parameters to temporary attachment storage. */
export async function routeAttachmentRpc<Method extends AttachmentRpcMethod>(
  method: Method,
  params: AttachmentRpcParamsByMethod[Method],
  deps: AttachmentRouterDeps,
): Promise<unknown> {
  return await attachmentHandlers[method](params, deps);
}

async function saveClipboardFile(
  params: AttachmentRpcParamsByMethod["clipboard.saveFile"],
): Promise<unknown> {
  if (!params.data) {
    throw new Error("clipboard.saveFile via JSON-RPC requires the data field; use binary upload instead");
  }
  const buffer = Buffer.from(params.data, "base64");
  const id = NodeCrypto.randomUUID();
  const extension = getExtension(params.fileName);
  const suffix = extension ? `.${extension}` : "";
  const tempDir = NodePath.join(NodeOS.tmpdir(), "mcode-attachments");
  await NodeFSPromises.mkdir(tempDir, { recursive: true });
  const tempPath = NodePath.join(tempDir, `${id}${suffix}`);
  await NodeFSPromises.writeFile(tempPath, buffer);
  return {
    id,
    name: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: buffer.byteLength,
    sourcePath: tempPath,
  };
}
