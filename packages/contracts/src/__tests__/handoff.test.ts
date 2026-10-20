import { describe, expect, it } from "vitest";
import { HandoffAuditMetadataSchema } from "../handoff.js";
import { SettingsSchema } from "../models/settings.js";

describe("handoff compatibility", () => {
  it("rejects legacy summary metadata at the v2 audit boundary", () => {
    expect(HandoffAuditMetadataSchema().safeParse({ schemaVersion: 1, mode: "minimal" }).success).toBe(false);
  });

  it("loads settings with retired chat options without losing active preferences", () => {
    const result = SettingsSchema().parse({
      chat: { handoff: { retiredBannerPreference: false } },
      notifications: { enabled: false },
    });
    expect(result.notifications.enabled).toBe(false);
    expect(Object.hasOwn(result, "chat")).toBe(false);
  });
});
