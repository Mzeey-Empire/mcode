import type { BrowserAutomationPublicOperation } from "@mcode/contracts";
import type { JsonSchemaObject } from "../mcode-toolkit.js";

const commonProperties = {
  expectedControlEpoch: { type: "integer", minimum: 0, description: "controlEpoch from the latest browser_inspect result" },
} as const;

const actTargetSchema = {
  oneOf: [
    { type: "object", properties: { semanticId: { type: "string", minLength: 1, maxLength: 1_024 } }, required: ["semanticId"], additionalProperties: false },
    { type: "object", properties: { role: { type: "string", minLength: 1, maxLength: 128 }, accessibleName: { type: "string", minLength: 1, maxLength: 1_024 } }, required: ["role", "accessibleName"], additionalProperties: false },
    { type: "object", properties: { cssSelector: { type: "string", minLength: 1, maxLength: 4_096 } }, required: ["cssSelector"], additionalProperties: false },
    { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 100_000 }, y: { type: "number", minimum: 0, maximum: 100_000 } }, required: ["x", "y"], additionalProperties: false },
  ],
} as const;

const actTimeoutSchema = { type: "integer", minimum: 1, maximum: 60_000 } as const;

function actStepSchema(
  operation: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "object",
    properties: { operation: { const: operation }, ...properties },
    required: ["operation", ...required],
    additionalProperties: false,
    ...extra,
  };
}

const actStepVariants = [
  actStepSchema("navigate", { url: { type: "string", format: "uri", minLength: 1, maxLength: 2_048 } }, ["url"]),
  actStepSchema("back", {}),
  actStepSchema("forward", {}),
  actStepSchema("reload", {}),
  actStepSchema("resize", { width: { type: "integer", minimum: 320, maximum: 7_680 }, height: { type: "integer", minimum: 240, maximum: 4_320 } }, ["width", "height"]),
  actStepSchema("hover", { target: actTargetSchema, timeoutMs: actTimeoutSchema }, ["target"]),
  actStepSchema("click", { target: actTargetSchema, button: { enum: ["left", "middle", "right"], default: "left" }, clickCount: { enum: [1, 2], default: 1 }, timeoutMs: actTimeoutSchema }, ["target"]),
  actStepSchema("drag", { source: actTargetSchema, target: actTargetSchema, timeoutMs: actTimeoutSchema }, ["source", "target"]),
  actStepSchema("type", { target: actTargetSchema, text: { type: "string", maxLength: 16_384 }, clear: { type: "boolean", default: false }, submit: { type: "boolean", default: false }, timeoutMs: actTimeoutSchema }, ["text"]),
  actStepSchema("press", { key: { type: "string", minLength: 1, maxLength: 64 }, modifiers: { type: "array", items: { enum: ["Alt", "Control", "Meta", "Shift"] }, maxItems: 4, default: [] }, timeoutMs: actTimeoutSchema }, ["key"]),
  actStepSchema("scroll", { target: actTargetSchema, deltaX: { type: "number", minimum: -100_000, maximum: 100_000, default: 0 }, deltaY: { type: "number", minimum: -100_000, maximum: 100_000 }, timeoutMs: actTimeoutSchema }, ["deltaY"]),
  actStepSchema("wait", { durationMs: { type: "integer", minimum: 1, maximum: 60_000 } }, ["durationMs"]),
  actStepSchema("assert", { target: actTargetSchema, text: { type: "string", minLength: 1, maxLength: 1_024 }, url: { type: "string", format: "uri", minLength: 1, maxLength: 2_048 } }, [], { anyOf: [{ required: ["target"] }, { required: ["text"] }, { required: ["url"] }] }),
  actStepSchema("recordingStart", {}),
  actStepSchema("recordingStop", {}),
];

const tabsMutationProperties = {
  idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
  observationRef: { type: "string", minLength: 1, maxLength: 256 },
  ...commonProperties,
} as const;

/**
 * Do not restore a top-level `oneOf`: fresh Cursor sessions failed to index or
 * discover `browser_tabs` when its MCP schema used a top-level `oneOf`. The flat
 * MCP schema is for indexing; the contracts Zod union remains authoritative for
 * action-dependent validation.
 */
const tabsInputSchema: JsonSchemaObject = {
  type: "object",
  properties: {
    ...tabsMutationProperties,
    action: {
      enum: ["select", "claim", "release", "close", "finalize"],
      description: "Select or claim requires tabId; finalize requires dispositions; release and close may omit tabId.",
    },
    tabId: { type: "string", minLength: 1, maxLength: 256 },
    dispositions: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          tabId: { type: "string", minLength: 1, maxLength: 256 },
          disposition: { enum: ["close", "release", "handoff", "deliverable"] },
        },
        required: ["tabId", "disposition"],
        additionalProperties: false,
      },
    },
  },
  required: ["action", "idempotencyKey", "observationRef"],
  additionalProperties: false,
};

const operationProperties: Record<Exclude<BrowserAutomationPublicOperation, "tabs">, Record<string, object>> = {
  inspect: { includeScreenshot: { type: "boolean", default: false }, includeDiagnostics: { type: "boolean", default: false } },
  act: {
    idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
    observationRef: { type: "string", minLength: 1, maxLength: 256 },
    deadlineMs: { type: "integer", minimum: 1, maximum: 60000 },
    steps: { type: "array", minItems: 1, maxItems: 8, items: { oneOf: actStepVariants } },
  },
  open: {
    url: { type: "string", format: "uri" },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
  },
  evaluate: {
    idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
    observationRef: { type: "string", minLength: 1, maxLength: 256 },
    deadlineMs: { type: "integer", minimum: 1, maximum: 60000 },
    expression: { type: "string", minLength: 1, maxLength: 65536 },
    awaitPromise: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 1, maximum: 60000 },
  },
};

const requiredByOperation: Partial<Record<BrowserAutomationPublicOperation, string[]>> = {
  open: ["idempotencyKey"],
  act: ["idempotencyKey", "observationRef", "deadlineMs", "steps"],
  evaluate: ["idempotencyKey", "observationRef", "deadlineMs", "expression"],
};

/** Returns the MCP `tools/list` input schema for one Browser operation. */
export function browserInputSchema(operation: BrowserAutomationPublicOperation): JsonSchemaObject {
  if (operation === "tabs") return tabsInputSchema;
  return {
    type: "object",
    properties: { ...commonProperties, ...operationProperties[operation] },
    required: requiredByOperation[operation] ?? [],
    additionalProperties: false,
  };
}

/** Returns the MCP `tools/list` description for one Browser operation. */
export function browserToolDescription(operation: BrowserAutomationPublicOperation): string {
  switch (operation) {
    case "open":
      return "Create one agent-owned background tab and return its initial Browser observation. Use a fresh idempotency key; this does not reveal or focus the Browser panel.";
    case "inspect":
      return "Inspect Browser readiness and return the canonical session-specific capabilities, constraints, tabs, observationRef, diagnostics, and recovery guidance.";
    case "act":
      return "Execute up to eight ordered Browser steps against the latest observationRef. Use a fresh idempotency key and stop at any failure, interruption, deadline, navigation, or invalidation boundary.";
    case "tabs":
      return "Select, claim, release, close, or finalize Browser tabs using the latest observationRef and a fresh idempotency key. Release claimed user tabs instead of closing them.";
    case "evaluate":
      return "Run privileged open-world page evaluation only when live negotiation advertises this tool. Use the same observationRef, idempotency, interruption, receipt, effect, and recovery rules as Browser mutations.";
  }
}
