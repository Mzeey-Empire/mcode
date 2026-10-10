import "reflect-metadata";
import { container } from "tsyringe";
import { SettingsSchema, type TerminalResolvedProfile } from "@mcode/contracts";
import { EnvService } from "../../../runtime/environment/env-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { TerminalProfileService } from "../profiles/terminal-profile-service.js";
import { TerminalCommandService } from "../commands/terminal-command-service.js";
import { TerminalService } from "../backends/legacy/terminal-service.js";
import { LegacyTerminalBackend } from "../backends/legacy/legacy-terminal-backend.js";
import type { PtyHostAdapter } from "../host/pty-host-adapter.js";

/** Stable fixture scope accepted by the real host protocol. */
export const ACTION_TEST_THREAD = "00000000-0000-4000-8000-000000000001";
/** Stable fixture workspace accepted by command preparation. */
export const ACTION_TEST_WORKSPACE = "00000000-0000-4000-8000-000000000002";

/** Composes real terminal services around a supplied host and an isolated checkout. */
export function actionTerminalTestFixture(host: PtyHostAdapter, cwd: string, profile: TerminalResolvedProfile) {
  const scope = container.createChildContainer();
  const threads = {
    findById: (id: string) => id === ACTION_TEST_THREAD ? {
      id, workspace_id: ACTION_TEST_WORKSPACE, mode: "direct", worktree_path: null,
      deleted_at: null, user_completed_at: null,
    } : null,
  };
  const workspaces = { findById: () => ({ id: ACTION_TEST_WORKSPACE, path: cwd }) };
  const profiles = { resolveLaunchProfile: async () => ({ requestedProfileId: "automatic" as const, resolvedProfile: profile }) };
  const settings = { get: () => SettingsSchema().parse({}), on: () => () => undefined };
  const env = { getEnv: () => Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value === undefined || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ? [] : [[name, value]]),
  ) };
  const hostRuntime = { platform: profile.platform === "windows" ? "win32" : "linux", architecture: "x64" };
  scope.registerInstance<unknown>("ThreadRepo", threads);
  scope.registerInstance<unknown>("WorkspaceRepo", workspaces);
  scope.registerInstance<unknown>("SettingsService", settings);
  scope.registerInstance<unknown>("PtyHost", host);
  scope.registerInstance<unknown>("HostRuntime", hostRuntime);
  scope.registerInstance<unknown>(EnvService, env);
  scope.registerInstance<unknown>(GitWorktreeService, { resolveWorkingDir: () => cwd });
  scope.registerInstance<unknown>(TerminalProfileService, profiles);
  const terminals = scope.resolve(TerminalService);
  scope.registerInstance(TerminalService, terminals);
  const backend = scope.resolve(LegacyTerminalBackend);
  const commands = new TerminalCommandService({
    threads, workspaces, profiles, settings, env,
    platform: profile.platform === "windows" ? "win32" : "linux", resolveWorkingDir: () => cwd,
  });
  return { scope, threads, workspaces, terminals, backend, commands };
}
