import * as NodeHTTP from "node:http";
import { WORKSPACE_IMAGE_MAX_BYTES } from "@mcode/contracts";
import { extractToken, matchesAuthToken } from "../../../../application/transport/auth.js";
import { readWorkspaceFileBytes, validateWorkspaceFilePath, workspaceImageMime, type FileService } from "../file-service.js";

type ImageRouteDeps = {
  authToken: string;
  fileService: Pick<FileService, "resolveWorkingDir">;
};

/** Serves authenticated, size-bounded workspace images for Files and project icons. */
export function handleWorkspaceImageRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  deps: ImageRouteDeps,
): boolean {
  if (req.method !== "GET" || !req.url?.startsWith("/workspace-images/")) return false;
  if (!matchesAuthToken(extractToken(req), deps.authToken)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }
  void serveImage(new URL(req.url, "http://localhost"), res, deps);
  return true;
}

async function serveImage(url: URL, res: NodeHTTP.ServerResponse, deps: ImageRouteDeps): Promise<void> {
  try {
    const image = await resolveImage(url, deps);
    res.writeHead(200, {
      "Content-Type": image.mime,
      "Content-Length": image.bytes.length,
      "Cache-Control": image.use === "icon" && url.searchParams.has("v") ? "private, max-age=31536000, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(image.bytes);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function resolveImage(url: URL, deps: ImageRouteDeps) {
  const workspaceId = decodeURIComponent(url.pathname.slice("/workspace-images/".length));
  const use = url.searchParams.get("use");
  if (!/^[^/]+$/.test(workspaceId) || (use !== "file" && use !== "icon")) throw new Error("Invalid image request");
  if (use === "icon" && url.searchParams.has("threadId")) throw new Error("Icons require workspace scope");
  const root = deps.fileService.resolveWorkingDir(workspaceId, url.searchParams.get("threadId") ?? undefined);
  const { path, fullPath } = validateWorkspaceFilePath(root, url.searchParams.get("path") ?? "");
  const mime = workspaceImageMime(path);
  if (!mime) throw new Error("Unsupported image type");
  const bytes = await readWorkspaceFileBytes(fullPath, WORKSPACE_IMAGE_MAX_BYTES[use]);
  if (bytes.length > WORKSPACE_IMAGE_MAX_BYTES[use]) throw new Error("Image exceeds limit");
  return { mime, use, bytes };
}
