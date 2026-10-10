import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeHTTP from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateWorkspaceFilePath } from "../../file-service.js";
import { handleWorkspaceImageRequest } from "../workspace-image-route.js";

let temp: string;
let root: string;
let threadRoot: string;
let server: NodeHTTP.Server;
let origin: string;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

beforeEach(async () => {
  temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-images-"));
  root = NodePath.join(temp, "workspace");
  threadRoot = NodePath.join(temp, "thread");
  NodeFS.mkdirSync(root);
  NodeFS.mkdirSync(threadRoot);
  NodeFS.writeFileSync(NodePath.join(root, "a..b.png"), png);
  NodeFS.writeFileSync(NodePath.join(threadRoot, "a..b.png"), "thread image");
  server = NodeHTTP.createServer((req, res) => {
    const handled = handleWorkspaceImageRequest(req, res, {
      authToken: "image-test-token",
      fileService: {
        resolveWorkspaceFile(workspaceId, relativePath, threadId) {
          if (workspaceId !== "workspace-1") throw new Error("Unknown workspace");
          if (threadId && threadId !== "thread-1") throw new Error("Thread does not belong to workspace");
          return validateWorkspaceFilePath(threadId ? threadRoot : root, relativePath, process.platform);
        },
      },
    });
    if (!handled) { res.writeHead(404); res.end("Not found"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  NodeFS.rmSync(temp, { recursive: true, force: true });
});

function imageUrl(path = "a..b.png", use = "file", extra: Record<string, string> = {}) {
  return `${origin}/workspace-images/workspace-1?${new URLSearchParams({ path, use, ...extra })}`;
}

function authenticated(url: string) {
  return fetch(url, { headers: { Authorization: "Bearer image-test-token" } });
}

describe("workspace image HTTP route", () => {
  it("requires auth and serves exact bytes with nosniff, sandbox CSP and no-store", async () => {
    const anonymous = await fetch(imageUrl());
    expect(anonymous.status).toBe(401);
    const wrong = await fetch(imageUrl(), { headers: { Authorization: "Bearer wrong" } });
    expect(wrong.status).toBe(401);
    const response = await authenticated(imageUrl());
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts img cookie auth and a token after the image query parameters", async () => {
    const cookie = await fetch(imageUrl(), { headers: { Cookie: "mcode-auth=image-test-token" } });
    expect(cookie.status).toBe(200);
    expect(Buffer.from(await cookie.arrayBuffer())).toEqual(png);
    const query = await fetch(imageUrl("a..b.png", "file", { token: "image-test-token" }));
    expect(query.status).toBe(200);
    expect(Buffer.from(await query.arrayBuffer())).toEqual(png);
  });

  it("serves 3 MB for Files, rejects it for icons, and caches small versioned icons", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 1);
    NodeFS.writeFileSync(NodePath.join(root, "large.png"), bytes);
    const file = await authenticated(imageUrl("large.png"));
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
    const tooLarge = await authenticated(imageUrl("large.png", "icon", { v: "1" }));
    expect(tooLarge.status).toBe(404);
    expect(await tooLarge.text()).toBe("Not found");
    const icon = await authenticated(imageUrl("a..b.png", "icon", { v: "2" }));
    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(png);
  });

  it("enforces the 20 MB Files cap", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "huge.png"), Buffer.alloc(20 * 1024 * 1024 + 1));
    const response = await authenticated(imageUrl("huge.png"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("does not cache an icon without a version", async () => {
    const response = await authenticated(imageUrl("a..b.png", "icon"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it("uses the thread checkout for Files and rejects all thread parameters for icons", async () => {
    const response = await authenticated(imageUrl("a..b.png", "file", { threadId: "thread-1" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("thread image");
    for (const threadId of ["thread-1", ""]) {
      const icon = await authenticated(imageUrl("a..b.png", "icon", { threadId }));
      expect(icon.status).toBe(404);
    }
    const foreignThread = await authenticated(imageUrl("a..b.png", "file", { threadId: "foreign-thread" }));
    expect(foreignThread.status).toBe(404);
  });

  it.each(["../x", "a/../../x", "/absolute.png", "C:\\absolute.png", "C:relative.png", "\\\\server\\share.png", "a//b.png", "a\0b.png", "", "missing.png", "not-image.txt"])("rejects %j without echoing the path", async (path) => {
    NodeFS.writeFileSync(NodePath.join(root, "not-image.txt"), "private content");
    const response = await authenticated(imageUrl(path));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("rejects an escaping symlink", async () => {
    const outside = NodePath.join(temp, "outside");
    NodeFS.mkdirSync(outside);
    NodeFS.writeFileSync(NodePath.join(outside, "secret.png"), png);
    NodeFS.symlinkSync(outside, NodePath.join(root, "escape"), "junction");
    const response = await authenticated(imageUrl("escape/secret.png"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("serves SVG with sandbox headers", async () => {
    NodeFS.writeFileSync(NodePath.join(root, "icon.svg"), "<svg/>");
    const response = await authenticated(imageUrl("icon.svg", "icon", { v: "1" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(await response.text()).toBe("<svg/>");
  });
});
