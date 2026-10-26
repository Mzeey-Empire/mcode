import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HTML_VISUAL_MAX_HTML_BYTES } from "@mcode/contracts";
import { FeatureRetentionLimitError } from "../../agents/canonical/accepted-feature-observations.js";
import { TurnVisualRejectedError, type CanonicalAcceptedProgress } from "../../agents/canonical/canonical-accepted-progress.js";
import { McodeSessionAuthority, type McodeSession } from "../mcode-session-authority.js";
import { createVisualsToolkit } from "../toolkits/visuals-toolkit.js";
import type { ImageFileReader } from "../toolkits/inline-local-images.js";

const session: McodeSession = { providerId: "codex", sessionId: "visual-session", threadId: "source-thread", threadControl: true };
const MESSAGE_ID = "4f6b77cc-cbd8-402b-9fb3-f1d93cd7f47b";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
type VisualRequest = Parameters<CanonicalAcceptedProgress["acceptTurnVisual"]>[0];

function setup(options: { lease?: boolean; files?: ImageFileReader; error?: Error } = {}) {
  const authority = new McodeSessionAuthority();
  if (options.lease !== false) {
    authority.activate({ sessionId: session.sessionId, sourceThreadId: session.threadId,
      sourceTurnId: "source-turn", sourceProviderId: "codex", permissionMode: "full" });
  }
  const published: VisualRequest[] = [];
  const toolkit = createVisualsToolkit({ authority, files: options.files, visuals: {
    acceptTurnVisual(request) {
      if (options.error) throw options.error;
      published.push(request);
      return { messageId: MESSAGE_ID };
    },
  } });
  const tool = toolkit.bind(session)?.tools.find((candidate) => candidate.name === "html_render");
  if (!tool) throw new Error("Missing html_render");
  return { toolkit, published, call: (args: unknown) => tool.call(args, { toolCallId: "visual-call", signal: new AbortController().signal }) };
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
}

describe("Visuals toolkit", () => {
  let directory: string;
  beforeEach(async () => { directory = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-visuals-")); });
  afterEach(async () => { await NodeFSPromises.rm(directory, { recursive: true, force: true }); });

  it("rejects calls without a lease and publishes nothing", async () => {
    const { call, published, toolkit } = setup({ lease: false });
    expect(errorText(await call({ title: "Chart", html: "<p/>" }))).toBe("html_render works only while a turn is running.");
    expect(published).toEqual([]);
    expect(toolkit.bind({ ...session, threadControl: false })).toBeNull();
  });

  it.each([79, 2001])("rejects height %s before publication", async (height) => {
    const { call, published } = setup();
    await expect(call({ title: "Chart", html: "<p/>", height })).rejects.toMatchObject({ code: -32602 });
    expect(published).toEqual([]);
  });

  it("defaults the height and reports the published page", async () => {
    const { call, published } = setup();
    expect((await call({ title: " Chart ", html: "<p/>" })).structuredContent)
      .toEqual({ messageId: MESSAGE_ID, title: "Chart", bytes: 4, inlinedImages: 0 });
    expect(published).toEqual([{ threadId: "source-thread", turnId: "source-turn",
      visual: { title: "Chart", html: "<p/>", maxHeight: 720 } }]);
  });

  it.each(process.platform === "win32" ? ["backslashes", "slashes", "file URL"] : ["POSIX", "file URL"])(
    "inlines a %s absolute path with the PNG MIME type", async (kind) => {
      const path = NodePath.join(directory, "chart space.png");
      await NodeFSPromises.writeFile(path, PNG);
      let reference = path;
      if (kind === "slashes") reference = path.replaceAll("\\", "/");
      if (kind === "file URL") reference = NodeURL.pathToFileURL(path).href;
      const { call, published } = setup();
      const result = await call({ title: "Image", html: `<img src='${reference}'>` });
      expect(result.structuredContent).toMatchObject({ inlinedImages: 1 });
      expect(published[0]?.visual.html).toBe(`<img src='data:image/png;base64,${PNG.toString("base64")}'>`);
    },
  );

  it("leaves relative, remote, data, blob and protocol-relative references untouched", async () => {
    const html = '<img src="chart.png"><img src="https://example.com/chart.png"><img src="//host/chart.png"><img src="data:image/png;base64,AA=="><img src="blob:chart">';
    const { call, published } = setup();
    expect((await call({ title: "Links", html })).structuredContent).toMatchObject({ inlinedImages: 0 });
    expect(published[0]?.visual.html).toBe(html);
  });

  it("reads only image paths and leaves links, stylesheets and prose as written", async () => {
    const path = NodePath.join(directory, "chart.png");
    await NodeFSPromises.writeFile(path, PNG);
    const html = `<a href="/docs">Docs</a><link rel="stylesheet" href="C:\\theme\\site.css"><p>Saved to ${path}</p><img src="${path}">`;
    const { call, published } = setup();
    expect((await call({ title: "Mixed", html })).structuredContent).toMatchObject({ inlinedImages: 1 });
    expect(published[0]?.visual.html).toBe(html.replace(`src="${path}"`, `src="data:image/png;base64,${PNG.toString("base64")}"`));
  });

  it("reads a repeated path once and replaces attributes and CSS everywhere", async () => {
    const path = NodePath.join(directory, "chart.png");
    await NodeFSPromises.writeFile(path, PNG);
    const readFile = vi.fn((file: string) => NodeFSPromises.readFile(file));
    const { call, published } = setup({ files: { realpath: NodeFSPromises.realpath, stat: NodeFSPromises.stat, readFile } });
    const html = `<img src="${path}"><a href='${path}'><svg xlink:href="${path}"></svg><video poster="${path}"></video><style>p{background:url('${path}')}i{background:url(${path})}</style>`;
    await call({ title: "Repeated", html });
    const uri = `data:image/png;base64,${PNG.toString("base64")}`;
    expect(published[0]?.visual.html).toBe(`<img src="${uri}"><a href='${uri}'><svg xlink:href="${uri}"></svg><video poster="${uri}"></video><style>p{background:url('${uri}')}i{background:url(${uri})}</style>`);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("rejects the post-inlining byte size even when the source fits", async () => {
    const path = NodePath.join(directory, "chart.png");
    await NodeFSPromises.writeFile(path, PNG);
    const html = "a".repeat(HTML_VISUAL_MAX_HTML_BYTES - Buffer.byteLength(path) - 14) + `<img src='${path}'>`;
    const { call, published } = setup();
    const result = await call({ title: "Large", html });
    const expectedBytes = Buffer.byteLength(html) - Buffer.byteLength(path) + `data:image/png;base64,${PNG.toString("base64")}`.length;
    expect(errorText(result)).toContain(`${expectedBytes.toLocaleString("en-US")} bytes after inlining 1 images`);
    expect(errorText(result)).toContain("524,288 bytes");
    expect(published).toEqual([]);
  });

  it("reports every bad image path and never publishes a partial page", async () => {
    const fake = NodePath.join(directory, "text.png");
    const text = NodePath.join(directory, "secret.txt");
    const alias = NodePath.join(directory, "alias.png");
    const folder = NodePath.join(directory, "folder.png");
    await NodeFSPromises.writeFile(fake, "plain text");
    await NodeFSPromises.writeFile(text, "plain text");
    await NodeFSPromises.mkdir(folder);
    const paths = [fake, alias, folder, "\\\\server\\share\\image.png", "file://server/share/image.png"];
    const realpath = (file: string) => file === alias ? Promise.resolve(text) : NodeFSPromises.realpath(file);
    const { call, published } = setup({ files: { realpath, stat: NodeFSPromises.stat, readFile: NodeFSPromises.readFile } });
    const message = errorText(await call({ title: "Bad images", html: paths.map((path) => `<img src='${path}'>`).join("") }));
    for (const path of paths) expect(message).toContain(path);
    expect(message).toContain("content is not a .png image");
    expect(message).toContain("not a supported image type");
    expect(message).toContain("not a regular file");
    expect(message).toContain("UNC paths are not supported");
    expect(published).toEqual([]);
  });

  it("rejects oversized image files before reading them", async () => {
    const path = NodePath.join(directory, "large.png");
    await NodeFSPromises.writeFile(path, Buffer.alloc(HTML_VISUAL_MAX_HTML_BYTES));
    const readFile = vi.fn((file: string) => NodeFSPromises.readFile(file));
    const { call, published } = setup({ files: { realpath: NodeFSPromises.realpath, stat: NodeFSPromises.stat, readFile } });
    expect(errorText(await call({ title: "Large", html: `<img src='${path}'>` }))).toContain("too large once encoded");
    expect(readFile).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("limits distinct paths before filesystem reads", async () => {
    const readFile = vi.fn((file: string) => NodeFSPromises.readFile(file));
    const { call, published } = setup({ files: { realpath: NodeFSPromises.realpath, stat: NodeFSPromises.stat, readFile } });
    const html = Array.from({ length: 65 }, (_, index) => `<img src='${NodePath.join(directory, `${index}.png`)}'>`).join("");
    expect(errorText(await call({ title: "Many", html }))).toContain("at most 64 distinct paths");
    expect(readFile).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it.each([
    [new TurnVisualRejectedError(), "html_render works only while a turn is running."],
    [new FeatureRetentionLimitError("Accepted thread system observations"), "The page is too large once encoded. Shrink the HTML or images and try again."],
  ])("maps publication failure %s to a useful tool error", async (error, message) => {
    const { call, published } = setup({ error });
    expect(errorText(await call({ title: "Chart", html: "<p/>" }))).toBe(message);
    expect(published).toEqual([]);
  });
});
