import type { BrowserAutomationPublicOperation } from "@mcode/contracts";
import type { JsonSchemaObject } from "../mcode-toolkit.js";

/** One browser_act action, mirroring the internal act step operations. */
export const BROWSER_ACT_ACTIONS = [
  "navigate", "back", "forward", "reload", "resize", "hover", "click", "drag",
  "type", "press", "scroll", "wait", "assert", "recordingStart", "recordingStop",
] as const;

const elementRefSchema = {
  type: "string",
  pattern: "^s[0-9]+e[0-9]+$",
  maxLength: 32,
} as const;

const timeoutSchema = { type: "integer", minimum: 1, maximum: 60_000 } as const;

/**
 * Do not add a top-level `oneOf`: fresh Cursor sessions failed to index or
 * discover Browser tools whose MCP schema used one. These flat schemas are for
 * indexing; the contracts Zod schemas stay authoritative for action-dependent
 * validation.
 */
const actInputSchema: JsonSchemaObject = {
  type: "object",
  properties: {
    action: { enum: BROWSER_ACT_ACTIONS },
    ref: { ...elementRefSchema, description: "Element reference from the latest browser_inspect snapshot. Target for hover, click, type, scroll, and assert; drop target for drag." },
    sourceRef: { ...elementRefSchema, description: "Element reference to drag from." },
    url: { type: "string", format: "uri", minLength: 1, maxLength: 2_048, description: "Required for navigate; expected page URL for assert." },
    width: { type: "integer", minimum: 320, maximum: 7_680 },
    height: { type: "integer", minimum: 240, maximum: 4_320 },
    button: { enum: ["left", "middle", "right"], default: "left" },
    clickCount: { enum: [1, 2], default: 1 },
    text: { type: "string", maxLength: 16_384, description: "Text to type, or text that assert expects on the page." },
    clear: { type: "boolean", default: false },
    submit: { type: "boolean", default: false },
    key: { type: "string", minLength: 1, maxLength: 64 },
    modifiers: { type: "array", items: { enum: ["Alt", "Control", "Meta", "Shift"] }, maxItems: 4, default: [] },
    deltaX: { type: "number", minimum: -100_000, maximum: 100_000, default: 0 },
    deltaY: { type: "number", minimum: -100_000, maximum: 100_000 },
    durationMs: { type: "integer", minimum: 1, maximum: 60_000 },
    timeoutMs: timeoutSchema,
  },
  required: ["action"],
  additionalProperties: false,
};

const tabsInputSchema: JsonSchemaObject = {
  type: "object",
  properties: {
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
  required: ["action"],
  additionalProperties: false,
};

const inputSchemaByOperation: Record<BrowserAutomationPublicOperation, JsonSchemaObject> = {
  open: {
    type: "object",
    properties: { url: { type: "string", format: "uri" } },
    required: [],
    additionalProperties: false,
  },
  inspect: {
    type: "object",
    properties: { includeScreenshot: { type: "boolean", default: false }, includeDiagnostics: { type: "boolean", default: false } },
    required: [],
    additionalProperties: false,
  },
  act: actInputSchema,
  tabs: tabsInputSchema,
  evaluate: {
    type: "object",
    properties: {
      expression: { type: "string", minLength: 1, maxLength: 65536 },
      awaitPromise: { type: "boolean" },
      timeoutMs: timeoutSchema,
    },
    required: ["expression"],
    additionalProperties: false,
  },
};

/** Returns the MCP `tools/list` input schema for one Browser operation. */
export function browserInputSchema(operation: BrowserAutomationPublicOperation): JsonSchemaObject {
  return inputSchemaByOperation[operation];
}

const descriptionByOperation: Record<BrowserAutomationPublicOperation, string> = {
  open: [
    "Use only the mcode MCP server for Mcode's shared Preview. Never initialize or use bundled generic Browser/Chrome/Node-REPL, or launch another browser or profile.",
    "For Browser-only tasks, do not run shell/terminal commands or read local skills/files; keep narration minimal.",
    "Create a sticky, agent-owned background tab without revealing or focusing the Browser panel.",
    "Returns tab metadata, not a page snapshot: call browser_inspect before targeting elements. Use browser_tabs to select, claim, release, close, or finalize tabs.",
  ].join(" "),
  inspect: [
    "Authoritative for Browser readiness, tabs, capabilities, constraints, diagnostics, and recovery guidance.",
    "Returns a snapshot whose elements each carry a ref such as s3e12. Target browser_act with these refs. Each inspection replaces the previous refs.",
    "Inspect before the first action and again whenever an action says to. Tool discovery does not prove readiness.",
    "Request includeScreenshot only for visual evidence or when the user asks. Verify every success claim against current page evidence.",
    "Use only mcode MCP browser tools; Browser-only tasks need no shell commands or local skills/files.",
  ].join(" "),
  act: [
    "Perform one Browser action per call. Target elements only with a ref from the latest browser_inspect snapshot; never guess an ambiguous target.",
    'Examples: `{ "action": "click", "ref": "s3e12" }`, `{ "action": "type", "ref": "s3e4", "text": "Ada", "submit": true }`, `{ "action": "navigate", "url": "https://example.com" }`.',
    "drag uses sourceRef and ref; assert needs ref, text, or url; wait needs durationMs.",
    "A ref from an older snapshot is refused: call browser_inspect and use the new refs. Navigation, back, forward, reload, and failed or interrupted actions end the snapshot.",
    "User input invalidates the snapshot. Stop or Take control interrupts execution, and Take control holds the Browser until Hand back, even after a new message. Keep completed effects and yield to the user.",
    "An applied receipt proves the action ran, not the intended outcome; verify with assert or a fresh inspection. Effects do not roll back, so check the receipt before retrying and never replay mutations automatically.",
    "Follow exactly one recovery instruction: inspect, reopen, wait, yield_to_user, or do_not_retry.",
  ].join(" "),
  tabs: [
    "Select, claim, release, close, or finalize Browser tabs.",
    "Select and claim require tabId; finalize requires dispositions; release and close may omit tabId.",
    "Call browser_tabs finalize before replying. Release claimed user tabs instead of closing them. Close agent tabs by default.",
    "For a tab the user wants open or usable, set disposition handoff and verify success.",
  ].join(" "),
  evaluate: [
    "Use browser_evaluate for privileged open-world page evaluation only when the live capability advertises it.",
    "All browser_act and browser_inspect rules apply, including readiness, interruption, receipts, effects, recovery, and current evidence.",
    "Use only mcode MCP browser tools, never another browser or profile. Browser-only tasks need no shell commands or local skills/files.",
  ].join(" "),
};

/** Returns the MCP `tools/list` description for one Browser operation. */
export function browserToolDescription(operation: BrowserAutomationPublicOperation): string {
  return descriptionByOperation[operation];
}
