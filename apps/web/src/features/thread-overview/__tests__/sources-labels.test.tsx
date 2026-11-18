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

  it("keeps the parent path when same-path sources differ only by query", () => {
    expect(sourceLabels(sources(
      "https://example.com/react/setup?v=1",
      "https://example.com/react/setup?v=2",
      "https://example.com/vue/setup?v=1",
      "https://example.com/vue/setup?v=2",
    ))).toEqual([
      "example.com/react/setup?v=1",
      "example.com/react/setup?v=2",
      "example.com/vue/setup?v=1",
      "example.com/vue/setup?v=2",
    ]);
  });

  it("shortens a long detail in the middle so its differing end stays visible", () => {
    expect(sourceLabels(sources(
      "https://example.com/docs/thread-overview-source-labels-before",
      "https://example.com/docs/thread-overview-source-labels-after",
    ))).toEqual([
      "example.com/…/thread-o…rce-labels-before",
      "example.com/…/thread-o…urce-labels-after",
    ]);
  });

  it("keeps the full detail when shortening would make two labels alike", () => {
    expect(sourceLabels(sources(
      "https://example.com/docs/release-one-notes-for-the-overview-card",
      "https://example.com/docs/release-two-notes-for-the-overview-card",
    ))).toEqual([
      "example.com/…/release-one-notes-for-the-overview-card",
      "example.com/…/release-two-notes-for-the-overview-card",
    ]);
  });

  it("keeps the bare host for a shared-host source at the site root", () => {
    expect(sourceLabels(sources("https://example.com/", "https://example.com/blog")))
      .toEqual(["example.com", "example.com/blog"]);
  });
});
