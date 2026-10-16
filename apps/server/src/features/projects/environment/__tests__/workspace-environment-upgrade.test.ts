import { describe, expect, it } from "vitest";
import { upgradeEnvironmentDocument } from "../workspace-environment-upgrade.js";

describe("upgradeEnvironmentDocument", () => {
  it("prepends legacy Setup, preserves overrides and unknown fields, and never mutates its input", () => {
    const input = {
      version: "0.0.1", setup: { default: "bun install", windows: "pnpm install" },
      future: { enabled: true },
      actions: [{ id: "setup", name: "Other", command: { default: "echo other" }, future: 2 },
        { id: "setup-2", name: "Second", command: { default: "echo second" } }],
    };
    const before = JSON.stringify(input);
    const result = upgradeEnvironmentDocument(input);
    expect(result).toEqual({
      version: "0.1.0", future: { enabled: true },
      actions: [{ id: "setup-3", name: "setup", command: input.setup, runOnStartup: true }, ...input.actions],
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(upgradeEnvironmentDocument(result)).toEqual(result);
  });

  it("keeps ordinary documents unchanged and rejects unsupported or malformed legacy commands", () => {
    const ordinary = { version: "0.0.1", actions: [] };
    expect(upgradeEnvironmentDocument(ordinary)).toEqual(ordinary);
    for (const input of [
      { ...ordinary, version: "0.2.0", setup: { default: "echo untrusted" } },
      { ...ordinary, setup: {} },
      { ...ordinary, setup: { default: "x\0y" } },
    ]) expect(() => upgradeEnvironmentDocument(input)).toThrow();
  });

  it("applies the startup count bound after upgrade", () => {
    const actions = Array.from({ length: 8 }, (_, index) => ({
      id: `action-${index}`, name: "Action", command: { default: "echo ok" }, runOnStartup: true,
    }));
    expect(() => upgradeEnvironmentDocument({ version: "0.0.1", setup: { default: "echo setup" }, actions })).toThrow();
  });
});
