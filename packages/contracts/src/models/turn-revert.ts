import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { MessageSchema, type Message } from "./message.js";

/** A whole logical turn, or one rename-connected file over a range of turns. */
export const TurnRevertScopeSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn") }).strict(),
  z.object({ kind: z.literal("file"), path: z.string().min(1).max(4096),
    fromMessageId: z.string().min(1).max(256).optional() }).strict(),
]));
/** Checkout action and later-edit warning for one attributed path. */
export const RevertFilePlanSchema = lazySchema(() => z.object({
  path: z.string().max(4096), previousPath: z.string().max(4096).optional(),
  action: z.enum(["restore", "delete", "recreate"]),
  state: z.enum(["clean", "changed_later", "already_reverted"]),
  changedBy: z.enum(["later_turn", "outside"]).optional(), binary: z.boolean(),
}));
/** Reasons retained snapshot or recovery evidence cannot be used. */
export const TurnRevertUnavailableSchema = z.enum([
  "not_git", "snapshot_missing", "snapshot_pruned", "worktree_missing", "no_attributed_files", "recovery_expired",
]);
/** Preview tokens bind raw worktree state, never request identity. */
const turnRevertPreview = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), previewToken: z.string().max(128),
    files: z.array(RevertFilePlanSchema()).max(512),
    skipped: z.array(z.object({ path: z.string().max(4096), reason: z.enum(["ignored", "submodule", "folder_in_the_way"]) })).max(512),
    unattributedChangeCount: z.number().int().nonnegative() }),
  z.object({ status: z.literal("nothing_to_revert") }),
  z.object({ status: z.literal("busy"), reason: z.enum(["turn_running", "revert_running"]) }),
  z.object({ status: z.literal("unavailable"), reason: TurnRevertUnavailableSchema }),
]));
/** Public receipt identity and affected paths of a durable revert operation. */
export const TurnRevertRecordSchema = lazySchema(() => z.object({
  id: z.string(), threadId: z.string(), targetMessageId: z.string(), fromMessageId: z.string().nullable(),
  kind: z.enum(["turn", "file", "undo"]), path: z.string().nullable(), undoesRevertId: z.string().nullable(),
  undoneByRevertId: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), previousPath: z.string().optional(), action: z.enum(["restore", "delete", "recreate"]) })).max(512),
  receiptMessageId: z.string(), createdAt: z.string(),
}));
/** Apply and Undo outcomes; validation errors are RPC errors. */
const turnRevertResult = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("reverted"), revert: TurnRevertRecordSchema(), receipt: MessageSchema() }),
  z.object({ status: z.literal("stale"), preview: TurnRevertPreviewSchema() }),
  z.object({ status: z.literal("busy"), reason: z.enum(["turn_running", "revert_running"]) }),
  z.object({ status: z.literal("unavailable"), reason: TurnRevertUnavailableSchema }),
  z.object({ status: z.literal("failed"), outcome: z.enum(["unchanged", "rolled_back", "recovery_failed"]),
    paths: z.array(z.string().max(4096)).max(512), detail: z.string().max(500) }),
]));
/** Validated revert scope. */
export type TurnRevertScope = z.infer<ReturnType<typeof TurnRevertScopeSchema>>;
/** Validated path preview. */
export type RevertFilePlan = z.infer<ReturnType<typeof RevertFilePlanSchema>>;
/** Validated preview outcome. */
export type TurnRevertPreview =
  | { status: "ready"; previewToken: string; files: RevertFilePlan[]; skipped: { path: string; reason: "ignored" | "submodule" | "folder_in_the_way" }[]; unattributedChangeCount: number }
  | { status: "nothing_to_revert" }
  | { status: "busy"; reason: "turn_running" | "revert_running" }
  | { status: "unavailable"; reason: z.infer<typeof TurnRevertUnavailableSchema> };
/** Bounded public schema type keeps the WebSocket registry declaration small. */
export const TurnRevertPreviewSchema: () => z.ZodType<TurnRevertPreview> = turnRevertPreview;
/** Public operation record. */
export type TurnRevertRecord = z.infer<ReturnType<typeof TurnRevertRecordSchema>>;
/** Validated mutation outcome. */
export type TurnRevertResult =
  | { status: "reverted"; revert: TurnRevertRecord; receipt: Message }
  | { status: "stale"; preview: TurnRevertPreview }
  | { status: "busy"; reason: "turn_running" | "revert_running" }
  | { status: "unavailable"; reason: z.infer<typeof TurnRevertUnavailableSchema> }
  | { status: "failed"; outcome: "unchanged" | "rolled_back" | "recovery_failed"; paths: string[]; detail: string };
/** Bounded public schema type keeps the WebSocket registry declaration small. */
export const TurnRevertResultSchema: () => z.ZodType<TurnRevertResult> = turnRevertResult;
