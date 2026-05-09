import { describe, it, expect } from "vitest";
import { getDefaultSettings, PartialSettingsSchema } from "../settings.js";

describe("settings.provider.enabled", () => {
  it("defaults claude/codex/copilot to true and others to false", () => {
    const s = getDefaultSettings();
    expect(s.provider.enabled).toEqual({
      claude: true, codex: true, copilot: true,
      gemini: false, cursor: false, opencode: false,
    });
  });

  it("accepts partial updates that flip individual providers", () => {
    const parsed = PartialSettingsSchema().parse({
      provider: { enabled: { codex: false } },
    });
    expect(parsed.provider?.enabled?.codex).toBe(false);
  });
});

describe("settings.provider.cursor", () => {
  it("fills Cursor ACP tuning defaults", () => {
    const s = getDefaultSettings();
    expect(s.provider.cursor).toEqual({
      alwaysSendFullInstructions: false,
      fullPreambleEveryNTurns: 12,
      idleSessionTtlMinutes: 20,
      retryTransientFailuresOnce: true,
      verboseFailureLogs: true,
      autoAnswerAskQuestions: true,
      echoAskQuestionsToTimeline: false,
    });
  });

  it("accepts PartialSettings overrides for Cursor ACP knobs", () => {
    const parsed = PartialSettingsSchema().parse({
      provider: {
        cursor: {
          alwaysSendFullInstructions: true,
          fullPreambleEveryNTurns: 0,
          idleSessionTtlMinutes: 60,
        },
      },
    });
    expect(parsed.provider?.cursor?.alwaysSendFullInstructions).toBe(true);
    expect(parsed.provider?.cursor?.fullPreambleEveryNTurns).toBe(0);
    expect(parsed.provider?.cursor?.idleSessionTtlMinutes).toBe(60);
  });
});
