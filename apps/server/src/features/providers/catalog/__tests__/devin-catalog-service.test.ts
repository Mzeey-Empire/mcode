import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { DevinCatalogService } from "../devin-catalog-service.js";

function createService(options: {
  rows?: unknown[];
  configuredPath?: string;
  resolvedPath?: string;
  probeError?: Error;
}) {
  const probe = {
    run: options.probeError
      ? vi.fn(async () => { throw options.probeError; })
      : vi.fn(async () => JSON.stringify(options.rows ?? [])),
  };
  const resolver = {
    which: vi.fn(async () => {
      if (options.resolvedPath === undefined) throw new Error("not found");
      return options.resolvedPath;
    }),
    statExecutable: vi.fn(async () => true),
  };
  const service = new DevinCatalogService(
    { get: () => ({ provider: { cli: { devin: options.configuredPath } } }) } as never,
    resolver as never,
    { getEnv: () => ({}) } as never,
    probe as never,
  );
  return { service, probe, resolver };
}

describe("DevinCatalogService", () => {
  it("maps Devin skills keeping collision prefixes and display names", async () => {
    const cwd = "C:/repo";
    const { service } = createService({
      resolvedPath: "devin",
      rows: [
        {
          name: "agents:review",
          description: "Review code",
          triggers: ["model", "user"],
          provider: "Devin",
          base_dir: `${cwd}/.agents/skills/review`,
          display_name: "review",
          warnings: [],
          errors: [],
        },
        {
          name: "claude:polish",
          description: "Polish UI",
          triggers: ["user"],
          provider: "Devin",
          base_dir: "C:/Users/test/.claude/skills/polish",
          display_name: "polish",
        },
        {
          name: "toolkit:lint",
          description: "Lint via plugin",
          triggers: ["user"],
          provider: "Plugin",
          base_dir: "C:/Users/test/AppData/Roaming/devin/cli/plugins/toolkit/skills/lint",
          display_name: "lint",
        },
      ],
    });

    const result = await service.refresh(cwd);

    expect(result.skillsAvailable).toBe(true);
    expect(result.freshness.status).toBe("fresh");
    expect(result.skills).toEqual([
      {
        name: "agents:review",
        description: "Review code",
        kind: "skill",
        source: "project",
        providers: ["devin"],
        nativeName: "review",
        path: `${cwd}/.agents/skills/review/SKILL.md`,
      },
      {
        name: "claude:polish",
        description: "Polish UI",
        kind: "skill",
        source: "user",
        providers: ["devin"],
        nativeName: "polish",
        path: "C:/Users/test/.claude/skills/polish/SKILL.md",
      },
      {
        name: "toolkit:lint",
        description: "Lint via plugin",
        kind: "skill",
        source: "plugin",
        providers: ["devin"],
        nativeName: "lint",
        path: "C:/Users/test/AppData/Roaming/devin/cli/plugins/toolkit/skills/lint/SKILL.md",
      },
    ]);
  });

  it("drops model-only skills and rows with unusable metadata", async () => {
    const { service } = createService({
      resolvedPath: "devin",
      rows: [
        {
          name: "internal",
          description: "Model only",
          triggers: ["model"],
          base_dir: "",
          display_name: "internal",
        },
        { name: "", description: "no name", triggers: ["user"] },
        {
          name: "kept",
          description: "User invocable",
          triggers: ["user"],
          base_dir: "",
          display_name: "kept",
        },
      ],
    });

    const result = await service.refresh();

    expect(result.skills.map((s) => s.name)).toEqual(["kept"]);
    expect(result.skills[0]).not.toHaveProperty("path");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "partial-result", sourceKind: "providerCatalog" }),
    ]);
  });

  it("reports unavailable when the probe fails", async () => {
    const { service } = createService({
      resolvedPath: "devin",
      probeError: new Error("exit 1"),
    });

    const result = await service.refresh("C:/repo");

    expect(result).toMatchObject({
      skills: [],
      skillsAvailable: false,
      freshness: { status: "stale" },
      diagnostics: [expect.objectContaining({ code: "source-unavailable" })],
    });
  });

  it("reports unavailable when no Devin CLI resolves", async () => {
    const { service, probe } = createService({});

    const result = await service.refresh();

    expect(result.skillsAvailable).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "source-unavailable",
        message: expect.stringContaining("provider.cli.devin"),
      }),
    ]);
    expect(probe.run).not.toHaveBeenCalled();
  });

  it("prefers the configured CLI path over PATH lookup", async () => {
    const { service, probe, resolver } = createService({
      configuredPath: "C:/tools/devin.exe",
      resolvedPath: "devin",
      rows: [],
    });

    await service.refresh("C:/repo");

    expect(probe.run).toHaveBeenCalledWith("C:/tools/devin.exe", "C:/repo", {});
    expect(resolver.which).not.toHaveBeenCalled();
  });
});
