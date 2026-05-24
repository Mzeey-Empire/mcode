import { describe, expect, it } from "vitest";
import {
  newHandoffUlid,
  resolveThreadHandoffsDir,
  resolveHandoffDir,
  resolveThreadAttachmentsDir,
} from "../handoffs.js";

describe("handoffs paths", () => {
  it("newHandoffUlid produces a 26-char Crockford Base32 string", () => {
    const ulid = newHandoffUlid();
    expect(ulid).toHaveLength(26);
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("newHandoffUlid is lexicographically sortable by creation time", async () => {
    const a = newHandoffUlid();
    await new Promise((r) => setTimeout(r, 2));
    const b = newHandoffUlid();
    expect(a < b).toBe(true);
  });

  it("resolveThreadHandoffsDir joins mcodeDir + threads/<id>/handoffs", () => {
    const result = resolveThreadHandoffsDir("/data", "t_1");
    // Use path.posix.join semantics: result depends on platform separator,
    // so just check endsWith for portability across win32/posix.
    expect(result.replace(/\\/g, "/")).toBe("/data/threads/t_1/handoffs");
  });

  it("resolveHandoffDir joins the ULID subdir", () => {
    const result = resolveHandoffDir("/data", "t_1", "01HX");
    expect(result.replace(/\\/g, "/")).toBe("/data/threads/t_1/handoffs/01HX");
  });

  it("resolveThreadAttachmentsDir is a sibling of handoffs", () => {
    const result = resolveThreadAttachmentsDir("/data", "t_1");
    expect(result.replace(/\\/g, "/")).toBe("/data/threads/t_1/attachments");
  });
});
