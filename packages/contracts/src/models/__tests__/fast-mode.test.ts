import { expect, it } from "vitest";
import { FastModeStatusSchema } from "../fast-mode.js";
import { SettingsSchema } from "../settings.js";

it.each(["on", "cooldown"])("rejects a block on %s", (state) => {
  expect(FastModeStatusSchema().safeParse({ modelId: "opus", state, unavailable: "plan" }).success).toBe(false);
});
it("parses Claude Fast settings and supplies the standard default", () => {
  expect(SettingsSchema().parse({}).provider.claude.fastMode).toBe(false);
  expect(SettingsSchema().parse({ provider: { claude: { fastMode: true } } }).provider.claude.fastMode).toBe(true);
});
