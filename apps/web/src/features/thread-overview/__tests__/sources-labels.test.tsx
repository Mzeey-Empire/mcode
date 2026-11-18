import { describe, expect, it } from "vitest";
import { sourceLabels } from "../entries/sources";

function sources(...urls: string[]) {
  return urls.map((url) => ({ url, faviconUrl: null }));
}

describe("overview source labels", () => {
  it("names a source by its host without a leading www", () => {
    expect(sourceLabels(sources("https://www.example.com/docs/intro", "https://vitest.dev/api")))
      .toEqual(["example.com", "vitest.dev"]);
  });

  it("adds the shortest path suffix that tells same-host sources apart", () => {
    expect(sourceLabels(sources(
      "https://github.com/openai/codex",
      "https://www.github.com/anthropics/claude-code/issues",
      "https://react.dev/learn",
    ))).toEqual(["github.com/…/codex", "github.com/…/issues", "react.dev"]);
  });

  it("keeps sources under one shared parent path apart", () => {
    expect(sourceLabels(sources("https://github.com/openai/codex", "https://github.com/openai/gpt")))
      .toEqual(["github.com/…/codex", "github.com/…/gpt"]);
    expect(sourceLabels(sources("https://example.com/docs/install", "https://example.com/docs/configure")))
      .toEqual(["example.com/…/install", "example.com/…/configure"]);
  });

  it("walks back up the path when the last segments match", () => {
    expect(sourceLabels(sources("https://example.com/a/setup", "https://example.com/b/setup")))
      .toEqual(["example.com/a/setup", "example.com/b/setup"]);
  });

  it("falls back to the query, then the fragment, when the paths are equal", () => {
    expect(sourceLabels(sources("https://example.com/docs?tab=api", "https://example.com/docs?tab=cli")))
      .toEqual(["example.com/docs?tab=api", "example.com/docs?tab=cli"]);
    expect(sourceLabels(sources("https://example.com/docs#install", "https://example.com/docs#usage")))
      .toEqual(["example.com/docs#install", "example.com/docs#usage"]);
  });

  it("keeps the bare host for a shared-host source at the site root", () => {
    expect(sourceLabels(sources("https://example.com/", "https://example.com/blog")))
      .toEqual(["example.com", "example.com/blog"]);
  });
});
