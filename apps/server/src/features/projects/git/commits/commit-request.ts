/**
 * Domain model of one durable Review commit request. A request is a union over its state so
 * code that reads a `committed` row cannot reach a push destination on a row that never
 * proved it made the commit.
 */
import * as NodeCrypto from "node:crypto";
import { z } from "zod";
import {
  GitCommitRejectionSchema,
  type GitCommitFile,
  type GitCommitPushOutcome,
  type GitCommitResult,
} from "@mcode/contracts";

/** Where a commit request pushes, captured under the lock before git runs. */
export const CommitPushDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standard"), remote: z.string().min(1), branch: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal("review"),
    worktreePath: z.string().min(1),
    remote: z.string().min(1),
    pushRef: z.string().min(1),
    localBranch: z.string().min(1),
    expectedHeadRepositoryUrl: z.string().min(1),
  }).strict(),
]);
/** Captured push destination of a commit request. */
export type CommitPushDestination = z.infer<typeof CommitPushDestinationSchema>;

const PushFailureSchema = z.object({ summary: z.string(), detail: z.string() }).strict();

const PushedSchema = z.object({ state: z.literal("pushed"), destination: CommitPushDestinationSchema }).strict();
const PushFailedSchema = z.object({
  state: z.literal("failed"),
  destination: CommitPushDestinationSchema,
  failure: PushFailureSchema,
}).strict();

/** A push that ran to an outcome. */
export const FinishedCommitPushSchema = z.discriminatedUnion("state", [PushedSchema, PushFailedSchema]);
/** A push that ran to an outcome. */
export type FinishedCommitPush = z.infer<typeof FinishedCommitPushSchema>;

/** Push progress of a committed request. Only committed requests carry one. */
export const CommitPushStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("skipped") }).strict(),
  z.object({ state: z.literal("pending"), destination: CommitPushDestinationSchema }).strict(),
  PushedSchema,
  PushFailedSchema,
]);
/** Push progress of a committed request. */
export type CommitPushState = z.infer<typeof CommitPushStateSchema>;

/** How a request ended once this process observed `git commit`, or once reconciliation gave up on proof. */
export const CommitSettlementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("committed"), commitSha: z.string().min(1), push: CommitPushStateSchema }).strict(),
  z.object({ state: z.literal("rejected"), rejection: GitCommitRejectionSchema() }).strict(),
  z.object({ state: z.literal("unknown"), head: z.string().nullable(), detail: z.string() }).strict(),
]);
/** Final state of a commit request. */
export type CommitSettlement = z.infer<typeof CommitSettlementSchema>;

const CommitRequestBaseSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  threadId: z.string().nullable(),
  repoPath: z.string().min(1),
  inputsHash: z.string().min(1),
  originalHead: z.string().nullable(),
  branch: z.string().nullable(),
  preparedAt: z.string(),
  updatedAt: z.string(),
}).strict();

/** Fields written before `git commit` runs. */
export const PreparedCommitRequestInputSchema = CommitRequestBaseSchema.omit({ preparedAt: true, updatedAt: true }).extend({
  destination: CommitPushDestinationSchema.nullable(),
}).strict();
/** Fields written before `git commit` runs. */
export type PreparedCommitRequestInput = z.infer<typeof PreparedCommitRequestInputSchema>;

/** A stored commit request, parsed once at the repository boundary. */
export const CommitRequestRecordSchema = z.union([
  CommitRequestBaseSchema.extend({ state: z.literal("prepared"), destination: CommitPushDestinationSchema.nullable() }).strict(),
  CommitRequestBaseSchema.extend({ state: z.literal("committed"), commitSha: z.string().min(1), push: CommitPushStateSchema }).strict(),
  CommitRequestBaseSchema.extend({ state: z.literal("rejected"), rejection: GitCommitRejectionSchema() }).strict(),
  CommitRequestBaseSchema.extend({ state: z.literal("unknown"), head: z.string().nullable(), detail: z.string() }).strict(),
]);
/** A stored commit request. */
export type CommitRequestRecord = z.infer<typeof CommitRequestRecordSchema>;
/** A stored request that has not yet been settled by any process. */
export type PreparedCommitRequest = Extract<CommitRequestRecord, { state: "prepared" }>;
/** A stored request this process proved made its commit. */
export type CommittedCommitRequest = Extract<CommitRequestRecord, { state: "committed" }>;

/** Inputs that identify one click. A replay must carry the same ones. */
export interface CommitRequestInputs {
  workspaceId: string;
  threadId: string | null;
  expectedHead: string | null;
  files: readonly GitCommitFile[];
  message: string;
  push: boolean;
}

/**
 * Hash the inputs a replay must repeat. Workspace and thread are included so a requestId
 * reused against another checkout cannot return this checkout's outcome.
 */
export function hashCommitRequestInputs(inputs: CommitRequestInputs): string {
  const canonical = JSON.stringify([
    inputs.workspaceId,
    inputs.threadId,
    inputs.expectedHead,
    inputs.files.map((file) => [file.path, file.previousPath]),
    inputs.message,
    inputs.push,
  ]);
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
}

/** Render a destination the way the push result reports it, for example "origin refs/heads/main". */
export function describePushDestination(destination: CommitPushDestination): string {
  const branch = destination.kind === "standard" ? destination.branch : destination.pushRef;
  return `${destination.remote} refs/heads/${branch}`;
}

function toPushOutcome(push: CommitPushState): GitCommitPushOutcome {
  switch (push.state) {
    case "skipped":
    case "pending":
      return { status: push.state };
    case "pushed":
      return { status: "pushed", destination: describePushDestination(push.destination) };
    case "failed":
      return { status: "failed", ...push.failure };
  }
}

/** Project a settled request onto the wire result. Prepared requests must be reconciled first. */
export function toCommitResult(
  record: Exclude<CommitRequestRecord, PreparedCommitRequest>,
): GitCommitResult {
  switch (record.state) {
    case "committed":
      return {
        status: "committed",
        sha: record.commitSha,
        shortSha: record.commitSha.slice(0, 7),
        branch: record.branch,
        push: toPushOutcome(record.push),
      };
    case "rejected":
      return { status: "rejected", reason: record.rejection };
    case "unknown":
      return { status: "unknown", head: record.head, detail: record.detail };
  }
}
