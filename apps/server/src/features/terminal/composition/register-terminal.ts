import { TERMINAL_MAX_SESSIONS } from "@mcode/contracts";
import { Lifecycle, type DependencyContainer } from "tsyringe";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";

import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { SettingsService } from "../../settings/settings-service.js";
import { EnvService } from "../../../runtime/environment/env-service.js";
import { PtyHostCleanupLedger } from "../cleanup/terminal-cleanup-ledger.js";
import { PtyHostSupervisor } from "../host/pty-host-supervisor.js";
import { PtyPidRegistry } from "../host/pty-pid-registry.js";
import {
  resolvePtyHostEntryPath,
  resolvePtyHostExecutable,
  spawnPtyHostChild,
} from "../host/pty-host-child.js";
import { TerminalBackend, TERMINAL_BACKEND_TOKEN } from "../backends/terminal-backend.js";
import { LegacyTerminalBackend } from "../backends/legacy/legacy-terminal-backend.js";
import { TerminalService as LegacyTerminalService } from "../backends/legacy/terminal-service.js";
import { TerminalCommandService } from "../commands/terminal-command-service.js";
import { TerminalDiagnosticsService } from "../diagnostics/terminal-diagnostics-service.js";
import { TerminalProfileService } from "../profiles/terminal-profile-service.js";
import { createTerminalProfileServiceOptions } from "../profiles/terminal-profile-service.js";
import { WorkspaceTerminalPreferencesService } from "../preferences/workspace-terminal-preferences-service.js";
import { terminalPlatform } from "../terminal-platform.js";

/** Register the terminal backend and diagnostics. */
export function registerTerminalBackends(container: DependencyContainer): void {
  let terminalCommandService: TerminalCommandService | undefined;
  container.register(TerminalCommandService, {
    useFactory: (c) => {
      if (terminalCommandService) return terminalCommandService;
      terminalCommandService = new TerminalCommandService({
        platform: c.resolve<HostRuntime>("HostRuntime").platform,
        profiles: c.resolve(TerminalProfileService),
        env: c.resolve(EnvService),
        settings: c.resolve(SettingsService),
        workspaces: c.resolve(WorkspaceRepo),
        threads: c.resolve(ThreadRepo),
        pidRegistry: c.resolve<PtyPidRegistry>("PtyPidRegistry"),
        resolveWorkingDir: (workspacePath, mode, worktreePath) =>
          c.resolve(GitWorktreeService).resolveWorkingDir(workspacePath, mode, worktreePath),
      });
      return terminalCommandService;
    },
  });
  container.register(
    LegacyTerminalService,
    { useClass: LegacyTerminalService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    LegacyTerminalBackend,
    { useClass: LegacyTerminalBackend },
    { lifecycle: Lifecycle.Singleton },
  );

  let ptyHost: PtyHostSupervisor | undefined;
  container.register("PtyHost", {
    useFactory: (c: DependencyContainer) => {
      if (ptyHost) return ptyHost;
      const hostRuntime = c.resolve<HostRuntime>("HostRuntime");
      ptyHost = new PtyHostSupervisor({
        platform: terminalPlatform(hostRuntime.platform),
        cleanupLedger: c.resolve(PtyHostCleanupLedger),
        spawnHost: () => spawnPtyHostChild({
          platform: hostRuntime.platform,
          architecture: hostRuntime.architecture,
          entryPath: resolvePtyHostEntryPath(process.argv[1] ?? process.cwd(), process.env),
          executablePath: resolvePtyHostExecutable(process.env),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }),
      });
      return ptyHost;
    },
  } as never);
  container.register<TerminalBackend>(TERMINAL_BACKEND_TOKEN, {
    useFactory: (c) => c.resolve(LegacyTerminalBackend),
  });
  container.register(
    TerminalDiagnosticsService,
    {
      useFactory: (c: DependencyContainer) => {
        const terminalService = c.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN);
        const host = c.resolve<PtyHostSupervisor>("PtyHost");
        return new TerminalDiagnosticsService({
          backend: () => terminalService.capabilities().backend,
          health: () => ({
            contractVersion: 1,
            state: host.health().state,
            hostGeneration: host.health().hostGeneration,
            activeSessions: Math.min(terminalService.listActiveSessions().length, TERMINAL_MAX_SESSIONS),
            ...host.diagnostics(),
          }),
        });
      },
    } as never,
  );
}

/** Register terminal settings and workspace preference services. */
export function registerTerminalPreferences(container: DependencyContainer): void {
  container.register(
    WorkspaceTerminalPreferencesService,
    { useClass: WorkspaceTerminalPreferencesService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(TerminalProfileService, {
    useFactory: (c) => new TerminalProfileService(
      c.resolve(SettingsService),
      c.resolve(WorkspaceTerminalPreferencesService),
      createTerminalProfileServiceOptions(c.resolve<HostRuntime>("HostRuntime").platform),
    ),
  });
}
