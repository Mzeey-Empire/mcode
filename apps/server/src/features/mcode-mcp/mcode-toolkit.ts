import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McodeSession } from "./mcode-session-authority.js";

/** JSON Schema object the MCP `tools/list` result accepts for tool input and output. */
export type JsonSchemaObject = Tool["inputSchema"];

/** Annotations the MCP `tools/list` result accepts for one tool. */
export type McodeToolAnnotations = NonNullable<Tool["annotations"]>;

/** Per-call context the server hands to a tool. */
export interface McodeToolCall {
  /** The JSON-RPC request id, normalized to 1 to 128 characters. */
  readonly toolCallId: string;
  /** Aborts when the client disconnects or cancels the request. */
  readonly signal: AbortSignal;
}

/** One tool a toolkit contributes, typed by the grant its toolkit resolves per request. */
export interface McodeTool<Grant> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
  readonly annotations?: McodeToolAnnotations;
  /** Hides the tool from `tools/list` for this grant; it stays callable and `call` decides. */
  readonly listed?: (grant: Grant) => boolean;
  call(args: unknown, grant: Grant, call: McodeToolCall): Promise<CallToolResult>;
}

/** A tool with its grant already resolved for the current request. */
export interface BoundTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
  readonly annotations?: McodeToolAnnotations;
  readonly listed: boolean;
  call(args: unknown, call: McodeToolCall): Promise<CallToolResult>;
}

/** The tools and `initialize` instructions one toolkit offers to one session. */
export interface BoundToolkit {
  readonly tools: readonly BoundTool[];
  readonly instructions: string | undefined;
}

/** A named group of tools that the `mcode` server exposes when a session is granted it. */
export interface McodeToolkit {
  readonly name: string;
  /** Returns null when the session has no grant for this toolkit. */
  bind(session: McodeSession): BoundToolkit | null;
}

/** Declares one toolkit; `grant` runs on every request, so revoked grants disappear at once. */
export function defineToolkit<Grant>(spec: {
  name: string;
  grant(session: McodeSession): Grant | null;
  tools: readonly McodeTool<Grant>[];
  instructions?(grant: Grant): string | undefined;
}): McodeToolkit {
  return {
    name: spec.name,
    bind(session) {
      const grant = spec.grant(session);
      if (grant === null) return null;
      return {
        tools: spec.tools.map((tool) => bindTool(tool, grant)),
        instructions: spec.instructions?.(grant),
      };
    },
  };
}

function bindTool<Grant>(tool: McodeTool<Grant>, grant: Grant): BoundTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    listed: tool.listed?.(grant) ?? true,
    call: (args, call) => tool.call(args, grant, call),
  };
}
