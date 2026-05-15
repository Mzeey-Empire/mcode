import { describe, it, expect } from "vitest";
import { resolveCodeBlockLanguage } from "@/lib/resolve-code-block-language";

describe("resolveCodeBlockLanguage", () => {
  it("passes normal fence tags through to the worker unchanged", () => {
    expect(resolveCodeBlockLanguage("ts")).toEqual({ language: "ts", label: "ts" });
    expect(resolveCodeBlockLanguage("typescript")).toEqual({ language: "typescript", label: "typescript" });
    expect(resolveCodeBlockLanguage("python")).toEqual({ language: "python", label: "python" });
  });

  it("maps GitHub start:end:path fences using the file path extension", () => {
    expect(resolveCodeBlockLanguage("12:34:preview-browser.ts")).toEqual({
      language: "typescript",
      label: "preview-browser.ts",
    });
    expect(resolveCodeBlockLanguage("1:10:apps/web/src/foo.tsx")).toEqual({
      language: "typescript",
      label: "foo.tsx",
    });
  });

  it("maps bare path fences with a known extension", () => {
    expect(resolveCodeBlockLanguage("src/lib/bar.rs")).toEqual({
      language: "rust",
      label: "bar.rs",
    });
    expect(resolveCodeBlockLanguage("hello.py")).toEqual({
      language: "python",
      label: "hello.py",
    });
  });

  it("infers from the first line when the fence info is empty", () => {
    expect(
      resolveCodeBlockLanguage(
        "",
        "88:99:components/CodeBlock.tsx\nexport const x = 1;\n",
      ),
    ).toEqual({
      language: "typescript",
      label: "CodeBlock.tsx",
    });
  });

  it("maps line:path fences (single line ref)", () => {
    expect(resolveCodeBlockLanguage("42:preview-browser.ts")).toEqual({
      language: "typescript",
      label: "preview-browser.ts",
    });
  });

  it("prefers start:end:path over line:path when both patterns could apply", () => {
    expect(resolveCodeBlockLanguage("12:34:deep/file.ts")).toEqual({
      language: "typescript",
      label: "file.ts",
    });
  });

  it("returns text when nothing matches", () => {
    expect(resolveCodeBlockLanguage("")).toEqual({ language: "text", label: "text" });
    expect(resolveCodeBlockLanguage("", "const n = 1;\n")).toEqual({ language: "text", label: "text" });
    expect(resolveCodeBlockLanguage("plain-words")).toEqual({ language: "plain-words", label: "plain-words" });
  });
});
