import { describe, it, expect, vi, beforeEach } from "vitest";
import { Package } from "lucide-react";
import { version } from "material-icon-theme/package.json";
import {
  clearIconCache,
  getIconName,
  getIconUrl,
  resolveIcon,
  resolveIconByName,
} from "@/lib/material-icons";

const CDN = `https://cdn.jsdelivr.net/npm/material-icon-theme@${version}/icons`;

const svgResponse = () => ({
  ok: true,
  blob: () => Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
});

function fetchedUrls(): unknown[] {
  return vi.mocked(globalThis.fetch).mock.calls.map(([url]) => url);
}

beforeEach(() => {
  clearIconCache();
  vi.restoreAllMocks();
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
});

describe("getIconName", () => {
  it.each([
    ["README.md", "readme"],
    ["notes.md", "markdown"],
    ["package.json", "nodejs"],
    ["index.test.ts", "test-ts"],
    ["types.d.ts", "typescript-def"],
    ["App.TSX", "react_ts"],
    [".env", "tune"],
    ["AGENTS.md", "agents-md"],
    ["AGENTS.override.md", "agents-md"],
    ["CLAUDE.md", "claude"],
    ["CLAUDE.local.md", "claude"],
  ])("matches %s to the %s icon, file name first, then the longest extension", (fileName, icon) => {
    expect(getIconName(fileName, "dark")).toBe(icon);
  });

  it("returns null when the theme would draw its generic file icon", () => {
    expect(getIconName("file.xyzabc123", "dark")).toBeNull();
  });

  it("uses an icon's light twin only on a light surface", () => {
    expect(getIconName("turbo.json", "light")).toBe("turborepo_light");
    expect(getIconName("turbo.json", "dark")).toBe("turborepo");
    expect(getIconName("index.ts", "light")).toBe("typescript");
  });
});

describe("getIconUrl", () => {
  it("points at the SVG from the installed package version", () => {
    expect(getIconUrl("index.ts", "dark")).toBe(`${CDN}/typescript.svg`);
  });
});

describe("resolveIcon", () => {
  it("returns the fetched SVG for a known file", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(svgResponse());

    expect(await resolveIcon("utils.ts", "dark")).toEqual({ type: "image", url: "blob:mock-url" });
    expect(fetchedUrls()).toEqual([`${CDN}/typescript.svg`]);
  });

  it("falls back to Lucide when the CDN is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    expect((await resolveIcon("utils.ts", "dark")).type).toBe("lucide");
  });

  it("falls back to Lucide without a fetch when the theme has no icon", async () => {
    globalThis.fetch = vi.fn();

    expect((await resolveIcon("file.xyzabc123", "dark")).type).toBe("lucide");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("serves the bundled AGENTS.md icon without touching the CDN", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    const resolved = await resolveIcon("AGENTS.md", "dark");

    expect(resolved).toEqual({ type: "image", url: getIconUrl("AGENTS.md", "dark") });
    expect(resolved).not.toMatchObject({ url: expect.stringContaining("cdn.jsdelivr.net") });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches each icon once, even for different files that share it", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(svgResponse());

    await Promise.all([resolveIcon("index.ts", "dark"), resolveIcon("index.ts", "dark")]);
    await resolveIcon("utils.ts", "dark");

    expect(fetchedUrls()).toEqual([`${CDN}/typescript.svg`]);
  });
});

describe("resolveIconByName", () => {
  it("fetches the light twin of a tool mark on a light surface", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(svgResponse());

    await resolveIconByName("bun", Package, "light");
    await resolveIconByName("bun", Package, "dark");

    expect(fetchedUrls()).toEqual([`${CDN}/bun_light.svg`, `${CDN}/bun.svg`]);
  });

  it("keeps the default mark on a light surface when the theme has no light twin", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(svgResponse());

    await resolveIconByName("docker", Package, "light");

    expect(fetchedUrls()).toEqual([`${CDN}/docker.svg`]);
  });

  it("returns the caller's fallback glyph when the CDN is unreachable, and does not retry", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    expect(await resolveIconByName("bun", Package, "dark")).toEqual({ type: "lucide", icon: Package });
    await resolveIconByName("bun", Package, "dark");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
