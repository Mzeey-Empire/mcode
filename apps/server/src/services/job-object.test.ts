import { describe, it, expect } from "vitest";
import { JobObject } from "./job-object.js";

describe("JobObject", () => {
  describe("on non-Windows platforms", () => {
    it("constructs without throwing and is a no-op", () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        const job = new JobObject();
        expect(() => job.assign(12345)).not.toThrow();
        expect(() => job.close()).not.toThrow();
        expect(job.isWindowsJob).toBe(false);
      } finally {
        Object.defineProperty(process, "platform", { value: original });
      }
    });
  });
});
