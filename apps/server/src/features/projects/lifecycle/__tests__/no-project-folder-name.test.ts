import { describe, expect, it } from "vitest";
import { noProjectFolderName, noProjectIdFromFolderName } from "../no-project-folder-name.js";

const ID = "56a6c168-2120-4fc7-82f9-46d161f44510";
const DATE = new Date(2026, 0, 5, 23, 30);

describe("No project folder names", () => {
  it.each([
    { hint: "Reply with the word yes", expected: "2026-01-05-reply-with-the-word" },
    { hint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ next", expected: "2026-01-05-abcdefghijklmnopqrstuvwx" },
    { hint: "check the reconfiguration now", expected: "2026-01-05-check-the" },
    { hint: "verify 12345678901234567 today", expected: "2026-01-05-verify-12345678901234567" },
    { hint: "Café déjà vu", expected: "2026-01-05-cafe-deja-vu" },
    { hint: "🧪🎉", expected: "2026-01-05" },
    { hint: "?!...---", expected: "2026-01-05" },
    { hint: "Привет мир", expected: "2026-01-05" },
    { hint: "   ", expected: "2026-01-05" },
    { hint: undefined, expected: "2026-01-05" },
  ])("builds and parses a folder name for $hint", ({ hint, expected }) => {
    const name = noProjectFolderName(ID, hint, DATE);
    expect(name).toBe(`${expected}-${ID}`);
    expect(noProjectIdFromFolderName(name)).toBe(ID);
  });

  it("preserves the case of the workspace ID", () => {
    const id = "56A6C168-2120-4FC7-82F9-46D161F44510";
    const name = noProjectFolderName(id, "Keep case", DATE);
    expect(name).toBe(`2026-01-05-keep-case-${id}`);
    expect(noProjectIdFromFolderName(name)).toBe(id);
  });

  it("uses the local calendar day just after midnight", () => {
    const date = new Date(2026, 6, 5, 0, 30);
    const name = noProjectFolderName(ID, undefined, date);
    expect(name).toBe(`2026-07-05-${ID}`);
    expect(noProjectIdFromFolderName(name)).toBe(ID);
  });

  it.each([
    ID,
    "2026-01-05-notes-56z6c168-2120-4fc7-82f9-46d161f44510",
    `2026-01-05-Notes-${ID}`,
    `2026-01-05-first--words-${ID}`,
    `notes-${ID}`,
    `2026-01-05-abcdefghijklmnopqrstuvwxy-${ID}`,
    `2026-01-05-one-two-three-four-five-${ID}`,
    `2026-02-30-notes-${ID}`,
    `2026-99-99-notes-${ID}`,
  ])("rejects %s", (name) => {
    expect(noProjectIdFromFolderName(name)).toBeNull();
  });
});
