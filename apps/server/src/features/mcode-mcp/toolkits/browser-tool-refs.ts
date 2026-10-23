import * as NodeCrypto from "node:crypto";
import type {
  BrowserAutomationActResult,
  BrowserAutomationActStep,
  BrowserAutomationError,
  BrowserAutomationEvaluateResult,
  BrowserAutomationPublicOperation,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserAutomationResult,
} from "@mcode/contracts";
import { browserInputSchema } from "./browser-tool-schemas.js";

/** The act and evaluate budget the model no longer chooses. */
export const BROWSER_TOOL_ACTION_DEADLINE_MS = 60_000;

/** Element references minted for one browser_inspect snapshot. */
export interface BrowserSnapshotRefs {
  readonly id: number;
  readonly semanticIds: readonly string[];
}

/**
 * Browser state the server keeps for one credential so the model never sends
 * it. The host still enforces freshness; this only supplies the latest values.
 */
export interface BrowserToolLedger {
  readonly observationRef?: string;
  readonly controlEpoch: number;
  readonly snapshot?: BrowserSnapshotRefs;
}

/** Ledger for a credential that has not observed the Browser yet. */
export const EMPTY_BROWSER_TOOL_LEDGER: BrowserToolLedger = { controlEpoch: 0 };

/** Internal arguments for one model call, a local refusal, or a malformed call. */
export type BrowserToolTranslation =
  | { readonly kind: "request"; readonly args: Record<string, unknown>; readonly expectedControlEpoch: number }
  | { readonly kind: "refused"; readonly error: BrowserAutomationError }
  | { readonly kind: "invalid" };

const REF_PATTERN = /^s(\d+)e(\d+)$/;
const NAVIGATION_ACTIONS: ReadonlySet<string> = new Set(["navigate", "back", "forward", "reload"]);
const INVALID: BrowserToolTranslation = { kind: "invalid" };

type Result<T extends BrowserAutomationResult["operation"]> = Extract<BrowserAutomationResult, { operation: T }>;

function elementRef(snapshotId: number, index: number): string {
  return `s${snapshotId}e${index + 1}`;
}

function staleSnapshot(message: string): BrowserToolTranslation {
  return {
    kind: "refused",
    error: { code: "STALE_TARGET_GENERATION", message, retryable: true, stage: "observation", effect: "none", recovery: "inspect" },
  };
}

function resolveRef(ledger: BrowserToolLedger, ref: unknown): string | undefined {
  const match = typeof ref === "string" ? REF_PATTERN.exec(ref) : null;
  if (!match || Number(match[1]) !== ledger.snapshot?.id) return undefined;
  return ledger.snapshot.semanticIds[Number(match[2]) - 1];
}

function hasOnlyListedFields(operation: BrowserAutomationPublicOperation, args: Record<string, unknown>): boolean {
  const properties = browserInputSchema(operation).properties ?? {};
  return Object.keys(args).every((key) => Object.hasOwn(properties, key));
}

function withTarget(
  step: Record<string, unknown>,
  field: "target" | "source",
  ref: unknown,
  ledger: BrowserToolLedger,
): BrowserToolTranslation | undefined {
  if (ref === undefined) return undefined;
  const semanticId = resolveRef(ledger, ref);
  if (semanticId === undefined) {
    return staleSnapshot(`Element reference ${String(ref).slice(0, 32)} is not in the latest snapshot. Call browser_inspect for a fresh snapshot and use its references.`);
  }
  step[field] = { semanticId };
  return undefined;
}

function actArgs(args: Record<string, unknown>, ledger: BrowserToolLedger, observationRef: string): BrowserToolTranslation {
  const { action, ref, sourceRef, ...fields } = args;
  if (typeof action !== "string") return INVALID;
  const step: Record<string, unknown> = { operation: action, ...fields };
  const refused = withTarget(step, "target", ref, ledger) ?? withTarget(step, "source", sourceRef, ledger);
  if (refused) return refused;
  return {
    kind: "request",
    expectedControlEpoch: ledger.controlEpoch,
    args: { idempotencyKey: NodeCrypto.randomUUID(), observationRef, deadlineMs: BROWSER_TOOL_ACTION_DEADLINE_MS, steps: [step] },
  };
}

function observedArgs(
  operation: "act" | "tabs" | "evaluate",
  args: Record<string, unknown>,
  ledger: BrowserToolLedger,
): BrowserToolTranslation {
  const observationRef = ledger.observationRef;
  if (observationRef === undefined) {
    return staleSnapshot("The Browser has no current snapshot. Call browser_inspect, then retry with its references.");
  }
  if (operation === "act") return actArgs(args, ledger, observationRef);
  const deadline = operation === "evaluate" ? { deadlineMs: BROWSER_TOOL_ACTION_DEADLINE_MS } : {};
  return {
    kind: "request",
    expectedControlEpoch: ledger.controlEpoch,
    args: { ...args, ...deadline, idempotencyKey: NodeCrypto.randomUUID(), observationRef },
  };
}

/**
 * Maps model-facing arguments onto the internal Browser contract, filling the
 * observation, control epoch, idempotency key, and deadline from the ledger.
 */
export function translateBrowserToolArgs(
  operation: BrowserAutomationPublicOperation,
  args: Record<string, unknown>,
  ledger: BrowserToolLedger,
): BrowserToolTranslation {
  if (!hasOnlyListedFields(operation, args)) return INVALID;
  switch (operation) {
    case "inspect":
      return { kind: "request", args, expectedControlEpoch: ledger.controlEpoch };
    case "open":
      return { kind: "request", args: { ...args, idempotencyKey: NodeCrypto.randomUUID() }, expectedControlEpoch: ledger.controlEpoch };
    default:
      return observedArgs(operation, args, ledger);
  }
}

function isMutationResult(
  result: BrowserAutomationResult,
): result is BrowserAutomationActResult | BrowserAutomationEvaluateResult {
  return (result.operation === "act" || result.operation === "evaluate") && "finalObservation" in result;
}

// Only a completed, non-navigating act keeps the refs: the host keeps its
// targets then. An evaluation can rewrite the page, so it always ends them.
function keepsSnapshot(request: BrowserAutomationRequest, result: BrowserAutomationActResult | BrowserAutomationEvaluateResult): boolean {
  if (result.operation !== "act" || result.outcome !== "completed") return false;
  const steps: readonly BrowserAutomationActStep[] = request.operation === "act" ? request.args.steps : [];
  return !steps.some((step) => NAVIGATION_ACTIONS.has(step.operation));
}

function afterMutation(
  ledger: BrowserToolLedger,
  request: BrowserAutomationRequest,
  result: BrowserAutomationActResult | BrowserAutomationEvaluateResult,
): BrowserToolLedger {
  return {
    controlEpoch: ledger.controlEpoch,
    ...(result.nextObservationRef ? { observationRef: result.nextObservationRef } : {}),
    ...(keepsSnapshot(request, result) && ledger.snapshot ? { snapshot: ledger.snapshot } : {}),
  };
}

function afterInspect(result: Result<"inspect">, snapshotId: number | undefined): BrowserToolLedger {
  const semanticIds = result.snapshot?.elements.map((element) => element.semanticId);
  return {
    controlEpoch: result.controlEpoch,
    ...(result.observationRef ? { observationRef: result.observationRef } : {}),
    ...(semanticIds && snapshotId !== undefined ? { snapshot: { id: snapshotId, semanticIds } } : {}),
  };
}

function afterSuccess(
  ledger: BrowserToolLedger,
  request: BrowserAutomationRequest,
  result: BrowserAutomationResult,
  snapshotId: number | undefined,
): BrowserToolLedger {
  if (isMutationResult(result)) return afterMutation(ledger, request, result);
  switch (result.operation) {
    case "inspect":
      return afterInspect(result, snapshotId);
    case "open":
      return { controlEpoch: result.controlEpoch, ...(result.observationRef ? { observationRef: result.observationRef } : {}) };
    case "tabs":
      return { controlEpoch: ledger.controlEpoch, ...(result.observationRef ? { observationRef: result.observationRef } : {}) };
    default:
      return ledger;
  }
}

/**
 * Advances the ledger after the broker answers. Any refusal drops the
 * observation and refs: a timeout may already have consumed the single-use
 * observation, so the next action must start from a fresh browser_inspect.
 */
export function advanceBrowserToolLedger(
  ledger: BrowserToolLedger,
  request: BrowserAutomationRequest,
  response: BrowserAutomationResponse,
  snapshotId: number | undefined,
): BrowserToolLedger {
  if (response.ok) return afterSuccess(ledger, request, response.result, snapshotId);
  return { controlEpoch: ledger.controlEpoch };
}

function projectInspect(result: Result<"inspect">, snapshotId: number | undefined): Record<string, unknown> {
  const { observationRef: _observationRef, controlEpoch: _controlEpoch, snapshot, ...rest } = result;
  if (!snapshot) return rest;
  const elements = snapshot.elements.map(({ semanticId: _semanticId, ...element }, index) => ({
    ref: elementRef(snapshotId ?? 0, index),
    ...element,
  }));
  return { ...rest, snapshot: { ...snapshot, elements } };
}

/** Removes internal bookkeeping from a Browser result and swaps semantic ids for refs. */
export function projectBrowserToolResult(
  result: BrowserAutomationResult,
  snapshotId: number | undefined,
): Record<string, unknown> {
  if (isMutationResult(result)) {
    const { finalObservation: _finalObservation, nextObservationRef: _nextObservationRef, ...rest } = result;
    return rest;
  }
  switch (result.operation) {
    case "inspect":
      return projectInspect(result, snapshotId);
    case "open": {
      const { observationRef: _observationRef, controlEpoch: _controlEpoch, ...rest } = result;
      return rest;
    }
    case "tabs": {
      const { observationRef: _observationRef, ...rest } = result;
      return rest;
    }
    default:
      return result;
  }
}
