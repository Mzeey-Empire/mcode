import {
  DelegateTaskInputSchema,
  DelegateTaskResultSchema,
  ThreadLaunchInputSchema,
  ThreadLaunchResultSchema,
  TaskStatusInputSchema,
  TaskStatusResultSchema,
  TaskCancelInputSchema,
  TaskCancelResultSchema,
  ThreadGetInputSchema,
  ThreadGetResultSchema,
  ThreadSearchInputSchema,
  ThreadSearchResultSchema,
  ThreadSendInputSchema,
  ThreadSendResultSchema,
  ThreadStopInputSchema,
  ThreadStopResultSchema,
  ThreadTargetListInputSchema,
  ThreadTargetListResultSchema,
  ThreadWaitInputSchema,
  ThreadWaitResultSchema,
  WorkspaceSearchInputSchema,
  WorkspaceSearchResultSchema,
  WorktreeListInputSchema,
  WorktreeListResultSchema,
} from "@mcode/contracts";
import type { InternalThreadControlAuthority } from "@mcode/thread-orchestration";
import {
  getParseErrorMessage,
  normalizeObjectSchema,
  safeParseAsync,
  type AnySchema,
  type SchemaOutput,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ErrorCode, McpError, ToolSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ThreadControlService } from "../../thread-control/index.js";
import type { DelegatedTaskService } from "../../thread-control/delegation/delegated-task-service.js";
import type { ThreadLaunchService } from "../../thread-control/launch/thread-launch-service.js";
import type { McodeSession, McodeSessionAuthority } from "../mcode-session-authority.js";
import {
  defineToolkit,
  type JsonSchemaObject,
  type McodeTool,
  type McodeToolkit,
} from "../mcode-toolkit.js";

/** The thread-control service methods the toolkit calls. */
export type ThreadControlToolService = Pick<
  ThreadControlService,
  | "workspaceSearch"
  | "worktreeList"
  | "threadTargetList"
  | "threadSearch"
  | "threadGet"
  | "threadSend"
  | "threadStop"
  | "threadWait"
> & Pick<DelegatedTaskService, "delegate" | "status" | "cancel"> & Pick<ThreadLaunchService, "launch">;

/** Dependencies for the thread-control toolkit. */
export interface ThreadControlToolkitOptions {
  authority: Pick<McodeSessionAuthority, "authorizeThreadControl" | "signal">;
  service: ThreadControlToolService;
}

type ToolContext = ThreadControlToolkitOptions;

interface ServiceToolSpec<Input extends AnySchema, Result extends AnySchema> {
  name: string;
  description: string;
  input: Input;
  result: Result;
  /** Keeps the result validated but out of `tools/list`, matching the legacy server. */
  omitListedOutput?: boolean;
  run(
    service: ThreadControlToolService,
    authority: InternalThreadControlAuthority,
    input: SchemaOutput<Input>,
    signal: AbortSignal | undefined,
  ): unknown;
}

const EMPTY_INPUT_SCHEMA: JsonSchemaObject = { type: "object", properties: {} };

/** Convert a tool schema to the MCP listing format. */
export function listedSchema(schema: AnySchema, pipeStrategy: "input" | "output"): JsonSchemaObject | undefined {
  const object = normalizeObjectSchema(schema);
  if (!object) return undefined;
  return ToolSchema.shape.inputSchema.parse(toJsonSchemaCompat(object, { strictUnions: true, pipeStrategy }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return a validated object as structured content with optional human-readable text. */
export function structuredResult(value: unknown, summary?: string): CallToolResult {
  if (!isRecord(value)) throw new Error("Thread-control tool result must be an object");
  const result: CallToolResult = { content: [{ type: "text", text: summary ?? JSON.stringify(value) }], structuredContent: value };
  if (value.status === "rejected") result.isError = true;
  return result;
}

function combineAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.some((signal) => signal.aborted)) return AbortSignal.abort();
  return AbortSignal.any(active);
}

/**
 * Failures that are not protocol errors become tool results, so a model can read
 * and recover from them; protocol errors keep their JSON-RPC code.
 */
export async function toToolResult(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : "Thread-control tool failed";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Parse external arguments while retaining the MCP invalid-params error code. */
export async function parseInput<Input extends AnySchema>(
  name: string,
  schema: Input,
  args: unknown,
): Promise<SchemaOutput<Input>> {
  const parsed = await safeParseAsync(schema, args);
  if (parsed.success) return parsed.data;
  throw new McpError(
    ErrorCode.InvalidParams,
    `Input validation error: Invalid arguments for tool ${name}: ${getParseErrorMessage(parsed.error)}`,
  );
}

function serviceTool<Input extends AnySchema, Result extends AnySchema>(
  context: ToolContext,
  spec: ServiceToolSpec<Input, Result>,
): McodeTool<McodeSession> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: listedSchema(spec.input, "input") ?? EMPTY_INPUT_SCHEMA,
    outputSchema: spec.omitListedOutput ? undefined : listedSchema(spec.result, "output"),
    call: (args, session, call) => toToolResult(async () => {
      const authority = context.authority.authorizeThreadControl(session, call.toolCallId);
      // Taken before the first await: a revoke during validation must still abort this call.
      const revoked = context.authority.signal(session.sessionId);
      const input = await parseInput(spec.name, spec.input, args);
      const signal = combineAbortSignals([revoked, call.signal]);
      const result = await spec.run(context.service, authority, input, signal);
      const validated = await safeParseAsync(spec.result, result);
      if (!validated.success) throw new Error(getParseErrorMessage(validated.error));
      return structuredResult(validated.data);
    }),
  };
}

function createTools(context: ToolContext): McodeTool<McodeSession>[] {
  return [
    serviceTool(context, {
      name: "workspace_search",
      description: "Resolve an explicitly named Project among registered Mcode workspaces. If no Project is named, use the active source thread's Project without discovery. Use returned workspaceId references for follow-up operations; never target the active source thread.",
      input: WorkspaceSearchInputSchema(),
      result: WorkspaceSearchResultSchema(),
      run: (service, authority, input) => service.workspaceSearch(authority, input),
    }),
    serviceTool(context, {
      name: "worktree_list",
      description: "List tracked worktrees only when resolving an explicit worktree or reference in a registered Mcode Project. Respect the requested worktree and use returned worktree references. Never target the active source thread.",
      input: WorktreeListInputSchema(),
      result: WorktreeListResultSchema(),
      omitListedOutput: true,
      run: (service, authority, input) => service.worktreeList(authority, input),
    }),
    ...createTaskTools(context),
    serviceTool(context, {
      name: "thread_target_list",
      description: "List provider and model targets currently usable for delegated tasks. Call before choosing a provider or model; pass exact returned providerId/modelId to delegate_task. Never assume a static provider list or target the active source thread.",
      input: ThreadTargetListInputSchema(),
      result: ThreadTargetListResultSchema(),
      run: (service, authority) => service.threadTargetList(authority),
    }),
    ...createThreadTools(context),
  ];
}

function createTaskTools(context: ToolContext): McodeTool<McodeSession>[] {
  return [
    serviceTool(context, {
      name: "delegate_task",
      description: "Delegate child work in the Coordinator's Project. Prefer Provider-native sub-agents when they support the chosen model. Call thread_target_list and use its exact providerId/modelId. Choose shared for the Coordinator's checkout or worktree for a new checkout at its local commit with project setup. Omitted permissionMode inherits the Coordinator's mode; a broader mode is forbidden. Run each review round as a fresh task carrying the brief, prior findings and open objections. The call returns immediately. The Coordinator is woken on finish, failure or a question; task_status reads acknowledge results. Retry the same input with the same clientRequestId to return the existing task. Interrupted tasks may resume.",
      input: DelegateTaskInputSchema(), result: DelegateTaskResultSchema(),
      run: (service, authority, input) => service.delegate(authority, input),
    }),
    serviceTool(context, {
      name: "thread_launch",
      description: 'Launch an ordinary top-level Mcode thread for the user, in its own workspace. Use it only when the user asks for a separate thread or conversation; never just because they said sub-agent. The new thread runs on its own and you are not notified when it finishes; use delegate_task when you need the result back. workspace: {type:"new_worktree", baseRef, startFromOrigin?} creates a worktree from a local branch, or from the fetched origin branch; {type:"existing_worktree", worktreePath, baseBranch?} uses one of this project\'s worktrees (baseBranch is required when it is detached); omitted or {type:"root"} uses the project root, NOT your current worktree. Project setup finishes before the first message runs. Provider and model default to yours. Permission and interaction modes default to yours and cannot be broader. A supervised caller cannot use new_worktree. Returns the new threadId; link it for the user.',
      input: ThreadLaunchInputSchema(), result: ThreadLaunchResultSchema(),
      run: (service, authority, input) => service.launch(authority, input),
    }),
    serviceTool(context, {
      name: "task_status",
      description: "Read and acknowledge a delegated task's current state and bounded result. Status follows its latest attempt and includes its threadId when available. The Coordinator is woken on finish, failure or a question, so polling is unnecessary. Interrupted tasks may resume.",
      input: TaskStatusInputSchema(), result: TaskStatusResultSchema(),
      run: (service, authority, input) => service.status(authority, input),
    }),
    serviceTool(context, {
      name: "task_cancel",
      description: "Cancel a task owned by this Coordinator. Pending launch approvals are cancelled without creating a thread; setup and running work use the existing stop flow. Supervised stops may return stopApprovalId for a human decision. Cancelling a finished task is a no-op. Finished/interrupted remains resumable; check task_status later after other work rather than polling in a loop.",
      input: TaskCancelInputSchema(), result: TaskCancelResultSchema(),
      run: (service, authority, input) => service.cancel(authority, input),
    }),
  ];
}

function createThreadTools(context: ToolContext): McodeTool<McodeSession>[] {
  return [
    serviceTool(context, {
      name: "thread_search",
      description: "Discover readable threads across registered Mcode Projects. Use returned threadId and workspaceId for follow-up operations. Never target the active source thread.",
      input: ThreadSearchInputSchema(),
      result: ThreadSearchResultSchema(),
      run: (service, authority, input) => service.threadSearch(authority, input),
    }),
    serviceTool(context, {
      name: "thread_get",
      description: "Read one bounded transcript using a returned threadId. Inspect results before sending follow-up work. Never target the active source thread.",
      input: ThreadGetInputSchema(),
      result: ThreadGetResultSchema(),
      run: (service, authority, input) => service.threadGet(authority, input),
    }),
    serviceTool(context, {
      name: "thread_send",
      description: "Assign or continue work in another normal Mcode thread using returned threadId and turnId references. Keep prompts faithful to the user's request and inspect results before follow-up work. Never target the active source thread.",
      input: ThreadSendInputSchema(),
      result: ThreadSendResultSchema(),
      run: (service, authority, input) => service.threadSend(authority, input),
    }),
    serviceTool(context, {
      name: "thread_stop",
      description: "Stop work in another normal Mcode thread using returned threadId and turnId references. Never target the active source thread.",
      input: ThreadStopInputSchema(),
      result: ThreadStopResultSchema(),
      run: (service, authority, input) => service.threadStop(authority, input),
    }),
    serviceTool(context, {
      name: "thread_wait",
      description: "Wait for exact readable threads to require attention or reach a terminal state, using returned threadId references. Inspect results before sending follow-up work. Never target the active source thread.",
      input: ThreadWaitInputSchema(),
      result: ThreadWaitResultSchema(),
      run: (service, authority, input, signal) => service.threadWait(authority, input, signal),
    }),
  ];
}

/**
 * Builds the thread-control toolkit. Listing depends on the session's attach-time
 * flag; every call re-derives its authority from the session's active turn lease.
 */
export function createThreadControlToolkit(options: ThreadControlToolkitOptions): McodeToolkit {
  return defineToolkit<McodeSession>({
    name: "thread-control",
    grant: (session) => (session.threadControl ? session : null),
    tools: createTools(options),
  });
}
