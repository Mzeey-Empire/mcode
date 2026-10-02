import { z } from "zod";
import { ResolvedExecutionSchema, ThreadPlacementSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

const identity = z.object({ threadId: z.string(), workspaceId: z.string(), execution: ResolvedExecutionSchema(), turnId: z.string(), callerId: z.string(), sourceThreadId: z.string().optional() });
const placement = ThreadPlacementSchema().options[1];
const create = identity.extend({ prompt: z.string(), placement });
const send = identity.extend({ message: z.string(), sourceTurnId: z.string().optional(), sourceProviderId: z.string().optional() });
const createApproval = create.extend({ operation: z.literal("thread_create_batch"), approvalId: z.string(), operationPhase: z.enum(["pre_provision", "provisioning", "provisioned", "dispatching", "dispatched"]) });
const sendApproval = send.extend({ operation: z.literal("thread_send"), approvalId: z.string(), operationPhase: z.enum(["pre_dispatch", "dispatching", "dispatched"]) });
const stopApproval = identity.extend({ operation: z.literal("thread_stop"), approvalId: z.string(), operationPhase: z.enum(["pre_dispatch", "dispatching", "dispatched"]) });

/** Validate the claimed approval before any external side effect is permitted. */
export const pendingThreadControlApprovalSchema = z.discriminatedUnion("operation", [createApproval, sendApproval, stopApproval]);

/** Durable approval claims and phase changes execute entirely on the writer connection. */
export const threadControlApprovalWriteOperations = {
  create: databaseWriteOperation("threadControlApproval.create", z.tuple([create]), z.string()),
  createSend: databaseWriteOperation("threadControlApproval.createSend", z.tuple([send.extend({ approvalId: z.string().optional() })]), z.string()),
  createStop: databaseWriteOperation("threadControlApproval.createStop", z.tuple([identity.extend({ approvalId: z.string().optional() })]), z.string()),
  claim: databaseWriteOperation("threadControlApproval.claim", z.tuple([z.string()]), pendingThreadControlApprovalSchema.nullable()),
  setOperationPhase: databaseWriteOperation("threadControlApproval.setOperationPhase", z.tuple([z.string(), z.enum(["pre_provision", "provisioning", "provisioned", "dispatching", "dispatched", "pre_dispatch"])]), z.boolean()),
  requeue: databaseWriteOperation("threadControlApproval.requeue", z.tuple([z.string()]), z.boolean()),
  requeueRecoveredProvisioning: databaseWriteOperation("threadControlApproval.requeueRecoveredProvisioning", z.tuple([z.string()]), z.boolean()),
  settle: databaseWriteOperation("threadControlApproval.settle", z.tuple([z.string(), z.enum(["approved", "rejected", "failed"])]), z.boolean()),
  requeueDispatch: databaseWriteOperation("threadControlApproval.requeueDispatch", z.tuple([z.string()]), z.boolean()),
};
