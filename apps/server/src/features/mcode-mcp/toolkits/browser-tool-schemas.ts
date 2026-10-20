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
      return [
        "Use only the mcode MCP server for Mcode's shared Preview. Never initialize or use bundled generic Browser/Chrome/Node-REPL, or launch another browser or profile.",
        "For Browser-only tasks, do not run shell/terminal commands or read local skills/files; keep narration minimal.",
        "Create a sticky, agent-owned background tab with a fresh idempotency key, without revealing or focusing the Browser panel.",
        "Returns tab metadata and an observationRef, not a semantic page observation. Use browser_tabs to select, claim, release, close, or finalize tabs.",
      ].join(" ");
    case "inspect":
      return [
        "Authoritative for Browser readiness, tabs, capabilities, constraints, diagnostics, revision, observationRef, and recovery guidance.",
        "Inspect before the first action unless browser_open returned sufficient snapshot evidence. Tool discovery does not prove readiness.",
        "Request includeScreenshot only for visual evidence or when the user asks. Verify every success claim against current page evidence.",
        "Use only mcode MCP browser tools; Browser-only tasks need no shell commands or local skills/files.",
      ].join(" ");
    case "act":
      return [
        "Use a semanticId from the latest inspection, then role plus accessibleName. Use CSS or coordinates only when no semantic target exists. Never guess an ambiguous target.",
        "Requires the latest observationRef, a fresh idempotencyKey, deadlineMs, and a non-empty steps array. Never send `steps: []`.",
        'Canonical click: `{ "observationRef": "<latest>", "idempotencyKey": "<fresh>", "deadlineMs": 30000, "steps": [{ "operation": "click", "target": { "semanticId": "<from-latest-inspect>" } }] }`.',
        "Required fields include wait durationMs, click target, and assert text/target/url. Use at most eight steps and 60 seconds.",
        "Stop on failure, interruption, deadline, or invalidation. Verify non-navigation effects with an assert step or fresh inspection. Navigation and reload end the batch; inspect again before another mutation.",
        "User input invalidates the observation. Stop or Take control interrupts execution. Take control holds the Browser until Hand back, even after a new message. Release held input, keep completed effects, and yield to the user.",
        "Inspect the receipt and effect before retrying. An applied receipt proves the action effect, not the intended outcome. Effects do not roll back. Never replay mutations automatically.",
        "Follow exactly one recovery instruction: inspect, reopen, wait, yield_to_user, or do_not_retry.",
      ].join(" ");
    case "tabs":
      return [
        "Select, claim, release, close, or finalize Browser tabs using the latest observationRef and a fresh idempotency key.",
        "Select and claim require tabId; finalize requires dispositions; release and close may omit tabId.",
        "Call browser_tabs finalize before replying. Release claimed user tabs instead of closing them. Close agent tabs by default.",
        "For a tab the user wants open or usable, set disposition handoff and verify success.",
      ].join(" ");
    case "evaluate":
      return [
        "Use browser_evaluate for privileged open-world page evaluation only when the live capability advertises it.",
        "All browser_act and browser_inspect rules apply, including readiness, targeting, observationRef, idempotency, interruption, receipts, effects, recovery, and current evidence.",
        "Use only mcode MCP browser tools, never another browser or profile. Browser-only tasks need no shell commands or local skills/files.",
      ].join(" ");
  }
}
