/**
 * Devin capability catalog backed by `devin skills list --json`.
 *
 * Devin already resolves its own discovery matrix (native .devin/.cognition/
 * .agents roots plus the claude/cursor/copilot/windsurf compat importers, with
 * its own collision-prefix rules), so Mcode shells out to the CLI instead of
 * duplicating the scan. Plugin skills arrive inside the same list as
 * `<plugin>:<skill>` names; `devin plugins list` has no JSON mode and is not
 * probed separately.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { inject, injectable } from "tsyringe";
import {
  getCatalogEntry,
  SkillInfoSchema,
  type ProviderCatalogFreshness,
  type ProviderCatalogSourceDiagnostic,
  type SkillInfo,
  type SkillSource,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../settings/settings-service.js";
import { EnvService } from "../../../runtime/environment/env-service.js";
import type { CliResolver } from "../availability/provider-availability-service.js";

const DEVIN_SKILLS_PROBE_TIMEOUT_MS = 15_000;
const DEVIN_SKILLS_PROBE_MAX_BUFFER = 16 * 1024 * 1024;

/** Result of probing Devin's own skill catalog for one working-directory context. */
export interface DevinCatalogRefreshResult {
  readonly skills: SkillInfo[];
  readonly diagnostics: ProviderCatalogSourceDiagnostic[];
  readonly freshness: ProviderCatalogFreshness;
  readonly skillsAvailable: boolean;
}

/**
 * Runs `devin skills list --json` and returns raw stdout. Kept behind an
 * injectable class so tests can stub the process boundary, mirroring
 * {@link CodexCatalogClientFactory}.
 */
@injectable()
export class DevinSkillsProbe {
  /** Executes the skills probe; rejects on non-zero exit or timeout. */
  async run(
    cliPath: string,
    cwd: string | undefined,
    env: Record<string, string>,
  ): Promise<string> {
    return await new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        cliPath,
        ["skills", "list", "--json"],
        {
          ...(cwd ? { cwd } : {}),
          env,
          windowsHide: true,
          timeout: DEVIN_SKILLS_PROBE_TIMEOUT_MS,
          maxBuffer: DEVIN_SKILLS_PROBE_MAX_BUFFER,
        },
        (error, stdout) => error ? reject(error) : resolve(stdout),
      );
    });
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Maps a Devin `base_dir` to the picker grouping source. Installed plugins
 * live under a `plugins/` segment; anything under the probed cwd is project;
 * everything else (user config dirs) is user.
 */
function skillSource(baseDir: string | undefined, cwd: string | undefined): SkillSource {
  if (!baseDir) return "user";
  const normalized = normalizePath(baseDir);
  if (normalized.includes("/plugins/")) return "plugin";
  const root = cwd ? normalizePath(cwd) : undefined;
  if (root && normalized.startsWith(`${root}/`)) return "project";
  return "user";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Rows without a `user` trigger are model-only skills, not slash-invocable. */
function isUserInvocable(triggers: unknown): boolean {
  return !Array.isArray(triggers) || triggers.length === 0 || triggers.includes("user");
}

/**
 * Maps one `devin skills list --json` row to a SkillInfo. `name` keeps Devin's
 * own collision prefix (`agents:`, `claude:`…) so the composer inserts exactly
 * what Devin expects to receive back.
 */
function mapSkill(row: unknown, cwd: string | undefined): SkillInfo | undefined {
  if (!isRecord(row)) return undefined;
  const name = nonEmptyString(row.name);
  if (!name || !isUserInvocable(row.triggers)) return undefined;
  const baseDir = nonEmptyString(row.base_dir);
  const parsed = SkillInfoSchema().safeParse({
    name,
    description: typeof row.description === "string" ? row.description : "",
    kind: "skill",
    source: skillSource(baseDir, cwd),
    providers: ["devin"],
    nativeName: nonEmptyString(row.display_name) ?? name,
    ...(baseDir ? { path: `${baseDir.replace(/\\/g, "/")}/SKILL.md` } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

function sourceDiagnostic(
  rejectedSource: string,
  code: ProviderCatalogSourceDiagnostic["code"],
  message: string,
): ProviderCatalogSourceDiagnostic {
  return {
    sourceKind: "providerCatalog",
    rejectedSource,
    severity: "warning",
    code,
    message,
  };
}

/** Lists Devin skills by shelling out to the Devin CLI for one context. */
@injectable()
export class DevinCatalogService {
  constructor(
    @inject(SettingsService) private readonly settings: SettingsService,
    @inject("CliResolver") private readonly resolver: CliResolver,
    @inject(EnvService) private readonly envService: EnvService,
    @inject(DevinSkillsProbe) private readonly probe: DevinSkillsProbe,
  ) {}

  /** Probes `devin skills list --json` scoped to the given working directory. */
  async refresh(cwd?: string): Promise<DevinCatalogRefreshResult> {
    const fetchedAt = new Date().toISOString();
    try {
      const cliPath = await this.resolveCliPath();
      if (!cliPath) {
        return this.unavailable(
          fetchedAt,
          "The Devin CLI is not installed; set provider.cli.devin in Settings.",
        );
      }
      // Without a context cwd the probe would inherit the server checkout and
      // leak that repo's project skills into the user-scope catalog.
      const stdout = await this.probe.run(cliPath, cwd ?? NodeOS.homedir(), this.envService.getEnv());
      const rows: unknown = JSON.parse(stdout);
      if (!Array.isArray(rows)) {
        return this.unavailable(fetchedAt, "The Devin skills catalog returned an unexpected shape.");
      }
      const skills: SkillInfo[] = [];
      let invalidMetadata = false;
      for (const row of rows) {
        const skill = mapSkill(row, cwd);
        if (skill) skills.push(skill);
        else invalidMetadata = true;
      }
      return {
        skills,
        diagnostics: invalidMetadata
          ? [sourceDiagnostic(
              "skills list --json",
              "partial-result",
              "Some Devin skills were omitted because their metadata was invalid.",
            )]
          : [],
        freshness: { status: "fresh", fetchedAt },
        skillsAvailable: true,
      };
    } catch (error) {
      logger.warn("Devin skills probe failed", {
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.unavailable(
        fetchedAt,
        "The Devin skills catalog is temporarily unavailable for this context.",
      );
    }
  }

  private unavailable(fetchedAt: string, message: string): DevinCatalogRefreshResult {
    return {
      skills: [],
      diagnostics: [sourceDiagnostic("skills list --json", "source-unavailable", message)],
      freshness: { status: "stale", fetchedAt, reason: message },
      skillsAvailable: false,
    };
  }

  private async resolveCliPath(): Promise<string | undefined> {
    const configured = this.settings.get().provider.cli.devin?.trim();
    if (configured) {
      return (await this.resolver.statExecutable(configured)) ? configured : undefined;
    }
    return await this.resolver
      .which(getCatalogEntry("devin").cliBinary)
      .catch(() => undefined);
  }
}
