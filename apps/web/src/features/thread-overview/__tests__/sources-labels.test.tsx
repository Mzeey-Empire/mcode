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

  it("adds the first path segment when two sources share a host", () => {
    expect(sourceLabels(sources(
      "https://github.com/openai/codex",
      "https://www.github.com/anthropics/claude-code/issues",
      "https://react.dev/learn",
    ))).toEqual(["github.com/openai", "github.com/anthropics", "react.dev"]);
  });

  it("keeps the bare host for a shared-host source at the site root", () => {
    expect(sourceLabels(sources("https://example.com/", "https://example.com/blog")))
      .toEqual(["example.com", "example.com/blog"]);
  });
});
