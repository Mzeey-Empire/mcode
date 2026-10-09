import { PlanVersionSchema, lazySchema, type PlanVersion } from "@mcode/contracts";
import { z } from "zod";

const legacyPlanSchema = lazySchema(() => z.object({
  id: z.string().uuid(), threadId: z.string(), messageId: z.string(),
  version: z.number().int().positive(), title: z.string(), contentMd: z.string(),
  status: z.enum(["draft", "accepted", "superseded"]), createdAt: z.string(),
}));

/** Reads historic canonical payloads without changing the retained event log. */
export function readCanonicalPlan(value: unknown): PlanVersion {
  if (typeof value === "object" && value !== null && "author" in value) return PlanVersionSchema().parse(value);
  const legacy = legacyPlanSchema().parse(value);
  return PlanVersionSchema().parse({ ...legacy,
    status: legacy.status === "draft" ? "ready" : legacy.status,
    author: "agent", providerId: null, captureSource: "fence", baseVersionId: null,
    revision: 0, updatedAt: legacy.createdAt, acceptedAt: null, acceptedMessageId: null,
  });
}
