import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ProtectedEnvStore } from "../protected-env-store.js";

describe("ProtectedEnvStore", () => {
  it("overlays startup MCODE_ values onto a resolved map", () => {
    const prev = process.env.MCODE_PORT;
    process.env.MCODE_PORT = "19400";
    try {
      const store = new ProtectedEnvStore();
      const merged = store.applyTo({ MCODE_PORT: "1", USER: "shell" });
      expect(merged.MCODE_PORT).toBe("19400");
      expect(merged.USER).toBe("shell");
    } finally {
      if (prev === undefined) {
        delete process.env.MCODE_PORT;
      } else {
        process.env.MCODE_PORT = prev;
      }
    }
  });

  it("honours protect() for non-prefixed keys", () => {
    const prev = process.env.CUSTOM_SERVER_FLAG;
    process.env.CUSTOM_SERVER_FLAG = "keep-me";
    try {
      const store = new ProtectedEnvStore();
      store.protect("CUSTOM_SERVER_FLAG");
      const merged = store.applyTo({ CUSTOM_SERVER_FLAG: "from-shell" });
      expect(merged.CUSTOM_SERVER_FLAG).toBe("keep-me");
    } finally {
      if (prev === undefined) {
        delete process.env.CUSTOM_SERVER_FLAG;
      } else {
        process.env.CUSTOM_SERVER_FLAG = prev;
      }
    }
  });
});
