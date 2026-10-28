import { Lifecycle, type DependencyContainer } from "tsyringe";
import { hostRuntime } from "@mcode/shared/node/host-runtime";

import { OpenCodeProvider } from "../adapters/opencode/opencode-provider.js";
import { ProviderRegistry } from "./provider-registry.js";
import { createProviderHostPorts, PROVIDER_TURN_PORT } from "./provider-host-ports.js";
import type { ProviderTurnPort } from "@mcode/providers";
import { BrowserAutomationSessionLease } from "../../browser-automation/index.js";
import { McodeMcpServer, McodeProviderPort, McodeSessionAuthority } from "../../mcode-mcp/index.js";
import { WorkerOwnedTurnRuntime } from "../../agents/execution/worker-owned-turn-runtime.js";
import { ScopedPreGrantService } from "../../agents/permissions/scoped-pre-grant.js";
import { EnvService } from "../../../runtime/environment/env-service.js";
import type { JobObject } from "../../../runtime/process/containment/job-object.js";
import {
  logProviderEventIngressDiagnostic,
  PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK,
  ProviderEventIngress,
  type ProviderEventIngressDiagnosticSink,
} from "./provider-event-ingress.js";

/** Register provider adapters, the provider registry, and provider host ports. */
export function registerProviderAdapters(container: DependencyContainer): void {
  container.register(
    ProviderEventIngress,
    { useClass: ProviderEventIngress },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register<ProviderEventIngressDiagnosticSink>(
    PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK,
    { useValue: logProviderEventIngressDiagnostic },
  );
  container.register(
    OpenCodeProvider,
    { useClass: OpenCodeProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(OpenCodeProvider),
  });
  container.register(
    ProviderRegistry,
    { useClass: ProviderRegistry },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IProviderRegistry", {
    useFactory: (c) => c.resolve(ProviderRegistry),
  });
  container.register("ProviderHostPorts", {
    useFactory: (c) => createProviderHostPorts({
      runtime: hostRuntime,
      envService: c.resolve(EnvService),
      jobObject: c.resolve<JobObject>("JobObject"),
      browser: c.resolve(BrowserAutomationSessionLease),
      mcode: new McodeProviderPort({
        authority: c.resolve(McodeSessionAuthority),
        // The server is built after the host ports, so it is resolved when a Provider attaches.
        server: () => c.resolve(McodeMcpServer),
        isBrowserConfigured: () => c.resolve(BrowserAutomationSessionLease).isConfigured(),
      }),
      grants: c.resolve(ScopedPreGrantService),
      ingress: c.resolve(ProviderEventIngress),
      eventOwnership: c.resolve(WorkerOwnedTurnRuntime).providerEvents,
      turns: () => c.resolve<ProviderTurnPort>(PROVIDER_TURN_PORT),
    }),
  });
}
