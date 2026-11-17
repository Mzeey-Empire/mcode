import { expect, it } from "vitest";
import { SettingsSchema } from "@mcode/contracts/models/settings";
import { fastModeDefault } from "../index.js";

it("keeps provider defaults independent", () => {
  const settings = SettingsSchema().parse({ provider: { claude: { fastMode: true } } });
  expect(fastModeDefault(settings, "claude")).toBe(true);
  expect(fastModeDefault(settings, "codex")).toBe(false);
  expect(fastModeDefault(settings, "cursor")).toBe(false);
});
