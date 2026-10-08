import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { getExtension, type WsMethodName, WS_METHODS } from "@mcode/contracts";
import type { z } from "zod";
import { container } from "tsyringe";
import { AttachmentService } from "../storage/attachment-service.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";

type AttachmentRpcMethod = "clipboard.saveFile" | "attachments.stageDraft";

type AttachmentRpcParamsByMethod = {
  [Method in AttachmentRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

type AttachmentHandlerMap = {
  [Method in AttachmentRpcMethod]: (
    params: AttachmentRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

const attachmentHandlers: AttachmentHandlerMap = {
  // JSON-RPC remains available for clients that cannot upload a binary frame.
  "clipboard.saveFile": saveClipboardFile,
  "attachments.stageDraft": ({ threadId, attachment }) => {
    const thread = container.resolve(ThreadRepo).findById(threadId);
    if (!thread || thread.deleted_at != null) throw new Error("Draft image thread does not exist");
    return container.resolve(AttachmentService).stageDraft(threadId, attachment);
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
): Promise<unknown> {
  return await attachmentHandlers[method](params);
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
