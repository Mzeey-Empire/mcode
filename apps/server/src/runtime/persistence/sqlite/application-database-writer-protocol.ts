import { z } from "zod";
import type { CanonicalWriterRequest, CanonicalWriterResponse } from "../../../features/agents/canonical/canonical-agent-writer-protocol.js";

/** Ordinary write envelope. Operation-specific schemas parse its input in the worker. */
export const OrdinaryDatabaseWriteRequestSchema = z.object({
  kind: z.literal("ordinary-write"),
  requestId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

/** Fixed connection-local reliability policy, ordered with application writes. */
export const DatabaseQueryOnlyRequestSchema = z.object({
  kind: z.literal("query-only-policy"), requestId: z.string().min(1),
  name: z.literal("database.queryOnly"), enabled: z.boolean(),
}).strict();

/** One transport shared by application mutations and receipt-backed canonical commands. */
export type ApplicationDatabaseWriterRequest = CanonicalWriterRequest | z.infer<typeof OrdinaryDatabaseWriteRequestSchema>
  | z.infer<typeof DatabaseQueryOnlyRequestSchema>;

/** Business failures roll back; policy failures and missing replies remain explicit. */
export type ApplicationDatabaseWriterResponse = CanonicalWriterResponse
  | { kind: "ordinary-written"; requestId: string; name: string; result: unknown }
  | { kind: "ordinary-failed"; requestId: string; name: string;
      failure: { name: string; message: string; code?: string; retryAfterSeconds?: number } };
