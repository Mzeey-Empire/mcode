import {
  PermissionDecisionSchema,
  PermissionRequestSchema,
  type IAgentProvider,
  type PermissionRequest,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { z } from "zod";

const PermissionRoutingSchema = z.object({
  requestId: z.string().min(1),
  threadId: z.string().min(1),
});

/** Safe display title for a provider request that cannot be validated. */
export const UNREADABLE_APPROVAL_TITLE = "Mcode couldn't read this request";

/** Push callbacks used by the Agents permission publication boundary. */
export interface AgentPermissionPublicationDeps {
  providerRegistry: { resolveAll(): Pick<IAgentProvider, "id" | "on" | "resolvePermission">[] };
  publishPermissionRequest: (request: PermissionRequest) => void;
  publishPermissionResolved: (payload: { requestId: string; decision: "allow" | "allow-session" | "deny" | "cancelled"; optionLabel?: string }) => void;
  stopSession: (threadId: string) => Promise<unknown>;
}

/** Publish a safe receipt and deny upstream, stopping the turn if denial fails. */
export function publishUnreadableStandIn(
  { requestId, threadId }: z.infer<typeof PermissionRoutingSchema>,
  provider: Pick<IAgentProvider, "id" | "resolvePermission">,
  { publishPermissionRequest, publishPermissionResolved, stopSession }: Pick<AgentPermissionPublicationDeps,
    "publishPermissionRequest" | "publishPermissionResolved" | "stopSession">,
): void {
  publishPermissionRequest({
    requestId,
    threadId,
    toolName: "Unreadable request",
    title: UNREADABLE_APPROVAL_TITLE,
    input: {},
  });
  let denied = false;
  try {
    denied = provider.resolvePermission?.(requestId, "deny") === true;
  } catch {
    logger.error("Provider could not deny unreadable permission request", { providerId: provider.id, requestId });
  }
  publishPermissionResolved({ requestId, decision: denied ? "deny" : "cancelled" });
  if (!denied) {
    void stopSession(threadId).catch(() => {
      logger.error("Failed to stop session after unreadable permission request", { providerId: provider.id, requestId, threadId });
    });
  }
}

/** Subscribe to provider permission events and publish only validated payloads. */
export function publishAgentPermissionEvents(deps: AgentPermissionPublicationDeps): void {
  const { providerRegistry, publishPermissionRequest, publishPermissionResolved } = deps;
  for (const provider of providerRegistry.resolveAll()) {
    provider.on("permission_request", (request) => {
      const routing = PermissionRoutingSchema.safeParse(request);
      if (!routing.success) {
        logger.error("Provider permission request has invalid routing", { providerId: provider.id });
        return;
      }
      const parsed = PermissionRequestSchema().safeParse(request);
      if (!parsed.success) {
        logger.warn("Provider permission request violated its contract", {
          providerId: provider.id,
          requestId: routing.data.requestId,
          issues: parsed.error.issues.map(({ path, code }) => ({ path, code })),
        });
        publishUnreadableStandIn(routing.data, provider, deps);
        return;
      }
      publishPermissionRequest(parsed.data);
    });

    provider.on("permission_resolved", (payload) => {
      const decision = PermissionDecisionSchema.safeParse(payload.decision);
      if (typeof payload.requestId !== "string" || !decision.success) {
        logger.warn("Provider permission resolution violated its contract", {
          providerId: provider.id,
        });
        return;
      }
      publishPermissionResolved({
        requestId: payload.requestId,
        decision: decision.data,
        ...(typeof payload.optionLabel === "string" ? { optionLabel: payload.optionLabel } : {}),
      });
    });
  }
}
