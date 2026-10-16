import { describe, expect, it } from "vitest";
import type { OpenInApp } from "@/transport/types";
import { resolveEditorId } from "../useFolderActions";

function app(id: string, kind: OpenInApp["kind"], detected = true): OpenInApp {
  return { id, label: id, kind, detected, iconKey: id } as OpenInApp;
}

const code = app("code", "editor");
const cursor = app("cursor", "editor");
const wt = app("wt", "terminal");
const explorer = app("explorer", "fileManager");

describe("resolveEditorId", () => {
  it("uses the thread's choice when it is a detected editor", () => {
    expect(resolveEditorId("cursor", "code", [code, cursor])).toBe("cursor");
  });

  it("skips a thread choice that is not an editor, such as an external terminal", () => {
    expect(resolveEditorId("wt", "code", [wt, code, explorer])).toBe("code");
  });

  it("falls back to the first detected editor when the global default is not an editor", () => {
    expect(resolveEditorId(null, "wt", [wt, cursor, code])).toBe("cursor");
  });

  it("ignores an editor that is not installed", () => {
    expect(resolveEditorId("code", null, [app("code", "editor", false), cursor])).toBe("cursor");
  });

  it("returns null when no editor is installed", () => {
    expect(resolveEditorId(null, null, [wt, explorer])).toBeNull();
  });
});
