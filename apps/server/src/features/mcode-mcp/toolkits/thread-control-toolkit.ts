import {
  ThreadCreateBatchInputSchema,
  ThreadCreateBatchResultSchema,
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
  | "threadCreateBatch"
  | "threadTargetList"
  | "threadSearch"
  | "threadGet"
  | "threadSend"
  | "threadStop"
  | "threadWait"
>;

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

function listedSchema(schema: AnySchema, pipeStrategy: "input" | "output"): JsonSchemaObject | undefined {
  const object = normalizeObjectSchema(schema);
  if (!object) return undefined;
  return ToolSchema.shape.inputSchema.parse(toJsonSchemaCompat(object, { strictUnions: true, pipeStrategy }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredResult(value: unknown): CallToolResult {
  if (!isRecord(value)) throw new Error("Thread-control tool result must be an object");
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
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
async function toToolResult(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : "Thread-control tool failed";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

async function parseInput<Input extends AnySchema>(
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
    serviceTool(context, {
      name: "thread_create_batch",
      description: "Create and start one to twenty normal, persistent Mcode threads only when explicitly requested, distinct from provider-native child agents. Default to the active source thread's Project without discovery; resolve an explicitly named Project with workspace_search and respect a requested worktree. Preserve the user's title and task in the prompt. For a new worktree use placement type new_worktree with the appropriate baseRef; omit branchName unless the user names a branch. Call thread_target_list before choosing a provider or model and pass exact returned providerId/modelId, including providerId when named; preserve named execution settings. Never target the active source thread. Track returned threadId with thread_get or thread_wait, inspect results before follow-up work, and use returned workspaceId, turnId, and worktree references.",
      input: ThreadCreateBatchInputSchema(),
      result: ThreadCreateBatchResultSchema(),
      run: (service, authority, input) => service.threadCreateBatch(authority, input),
    }),
    serviceTool(context, {
      name: "thread_target_list",
      description: "List provider and model targets currently usable for new Mcode threads. Call before choosing a provider or model; pass exact returned providerId/modelId to thread_create_batch. Never assume a static provider list or target the active source thread.",
      input: ThreadTargetListInputSchema(),
      result: ThreadTargetListResultSchema(),
      run: (service, authority) => service.threadTargetList(authority),
    }),
    ...createThreadTools(context),
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
