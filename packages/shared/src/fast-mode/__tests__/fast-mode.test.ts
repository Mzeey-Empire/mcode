import { expect, it } from "vitest";
import { SettingsSchema } from "@mcode/contracts/models/settings";
import { fastModeDefault, fastModeSettingProvider } from "../index.js";

it("keeps provider defaults independent", () => {
  const settings = SettingsSchema().parse({ provider: { claude: { fastMode: true } } });
  expect(fastModeDefault(settings, "claude")).toBe(true);
  expect(fastModeDefault(settings, "codex")).toBe(false);
  expect(fastModeDefault(settings, "cursor")).toBe(false);
});

it("offers a Fast setting only for providers that store one", () => {
  expect(fastModeSettingProvider("claude")).toBe("claude");
  expect(fastModeSettingProvider("codex")).toBe("codex");
  expect(fastModeSettingProvider("devin")).toBeNull();
});
