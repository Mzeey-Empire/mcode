import { describe, expect, it } from "vitest";
import {
  newHandoffUlid,
  resolveThreadHandoffsDir,
  resolveHandoffDir,
  resolveThreadAttachmentsDir,
  resolveThreadPlanFile,
} from "../handoffs.js";

describe("handoffs paths", () => {
  it("keeps plan files in the thread directory and rejects path traversal", () => {
    expect(resolveThreadPlanFile("/data", "t_1").replace(/\\/g, "/")).toBe("/data/threads/t_1/plan.md");
    for (const id of ["", ".", "..", "../other", "..\\other", "/absolute", "C:relative", "bad\0id"]) {
      expect(() => resolveThreadPlanFile("/data", id)).toThrow();
    }
  });
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

  it("resolveHandoffDir joins the ULID subdir and rejects anything else", () => {
    const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(resolveHandoffDir("/data", "t_1", ulid).replace(/\\/g, "/")).toBe(`/data/threads/t_1/handoffs/${ulid}`);
    for (const id of ["01HX", `../${ulid}`, ulid.toLowerCase()]) {
      expect(() => resolveHandoffDir("/data", "t_1", id)).toThrow();
    }
  });

  it("resolveThreadAttachmentsDir is a sibling of handoffs", () => {
    const result = resolveThreadAttachmentsDir("/data", "t_1");
    expect(result.replace(/\\/g, "/")).toBe("/data/threads/t_1/attachments");
  });
});
