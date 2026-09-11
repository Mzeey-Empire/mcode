import type { ReasoningLevel } from "../models/settings.js";
import type { ProviderModelInfo } from "./models.js";

/**
 * Devin model rows shown while live ACP discovery (`configOptions` on
 * `session/new`) is unavailable or in flight. Devin's model catalog is
 * account-scoped, so the live list is always preferred when it resolves.
 */
export const DEVIN_STATIC_MODEL_FALLBACK: readonly ProviderModelInfo[] = [
  { id: "swe-2-high", name: "SWE-2 High", group: "Cognition" },
  { id: "swe-2-medium", name: "SWE-2 Medium", group: "Cognition" },
  { id: "swe-2-max", name: "SWE-2 Max", group: "Cognition" },
  { id: "swe-1-7", name: "SWE-1.7", group: "Cognition" },
  { id: "swe-1-7-medium", name: "SWE-1.7 Medium", group: "Cognition" },
];

/** Devin effort tokens, in canonical low→high order. */
export const DEVIN_EFFORT_ORDER: readonly ReasoningLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * A Devin model family: one selectable model whose reasoning effort Devin
 * bakes into the concrete model id (`swe-2` + `high` → `swe-2-high`).
 */
export interface DevinModelFamily {
  /** Selectable family id shown to users (e.g. `swe-2`, `gpt-5-6-sol-priority`). */
  id: string;
  /** Display name with the effort phrase removed (e.g. `SWE-2`). */
  name: string;
  group?: string;
  supportedReasoningEfforts: ReasoningLevel[];
  defaultReasoningEffort?: ReasoningLevel;
  /** Effort level → concrete catalog id Devin expects. */
  effortModelIds: Partial<Record<ReasoningLevel, string>>;
  /** Bare catalog id for families that also ship an effort-free variant. */
  bareModelId?: string;
}

/** Tail variants that follow the effort token in a Devin model id. */
const DEVIN_VARIANT_TAILS = ["priority", "fast", "1m"] as const;

const EFFORT_TOKEN_PATTERN = DEVIN_EFFORT_ORDER.join("|");
const TAIL_PATTERN = DEVIN_VARIANT_TAILS.join("|");
const DEVIN_EFFORT_SUFFIX = new RegExp(`^(.+)-(${EFFORT_TOKEN_PATTERN})((?:-(?:${TAIL_PATTERN}))*)$`);

const EFFORT_NAME_WORDS: Record<ReasoningLevel, string> = {
  none: "No",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-?High",
  max: "Max",
};

const EFFORT_WORD_TO_LEVEL: Record<string, ReasoningLevel> = {
  no: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  max: "max",
};

const IMPLICIT_EFFORT_NAME = /\s+(No|Minimal|Low|Medium|High|X-?High|Max)(\s+Thinking)?(\s+Fast|\s+1M)?\s*$/i;

/**
 * Reads the effort a bare id implies from its display name
 * (`SWE-1.7 Max` → `max`, `GLM-5.2 High 1M` → `high`). Devin's bare catalog
 * ids are aliases for a fixed effort, so the name is the only source.
 */
function implicitEffortFromName(name: string): ReasoningLevel | undefined {
  const match = name.match(IMPLICIT_EFFORT_NAME);
  return match ? EFFORT_WORD_TO_LEVEL[match[1].toLowerCase()] : undefined;
}

function stripEffortFromName(name: string, effort: ReasoningLevel): string {
  const word = EFFORT_NAME_WORDS[effort];
  const stripped = name
    .replace(new RegExp(`\\s+${word}(\\s+Thinking)?`, "i"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped || name;
}

function orderEfforts(efforts: Iterable<ReasoningLevel>): ReasoningLevel[] {
  const seen = new Set(efforts);
  return DEVIN_EFFORT_ORDER.filter((effort) => seen.has(effort));
}

interface DevinFamilyAccumulator extends DevinModelFamily {
  firstName: string;
  effortSeen: ReasoningLevel | undefined;
  /** Effort implied by a merged bare row's name (`SWE-1.7 Max` → `max`). */
  implicitBareEffort?: ReasoningLevel;
}

/**
 * Folds a bare catalog row (`swe-1-7`) into its effort-suffixed family. A bare
 * id's effort lives only in its display name (`SWE-1.7 Max`), so registering
 * the implicit effort lets the reasoning pill round-trip back to the bare
 * variant.
 */
function mergeBareModelRow(
  family: DevinFamilyAccumulator,
  models: ProviderModelInfo[],
  bareRowIndex: Map<string, number>,
): void {
  const bareIndex = bareRowIndex.get(family.id);
  if (bareIndex === undefined) return;
  const bare = models[bareIndex];
  family.bareModelId = bare.id;
  const implicit = implicitEffortFromName(bare.name);
  if (implicit) {
    family.implicitBareEffort = implicit;
    family.effortModelIds[implicit] = bare.id;
    family.name = stripEffortFromName(bare.name, implicit);
  } else {
    family.name = bare.name;
  }
  models.splice(bareIndex, 1);
  bareRowIndex.delete(family.id);
  // Removal shifts later indexes; rebuild to keep lookups correct.
  bareRowIndex.forEach((index, id) => {
    if (index > bareIndex) bareRowIndex.set(id, index - 1);
  });
}

/**
 * Groups Devin's flat catalog ids into selectable families. Devin encodes
 * reasoning effort inside the model id (`{base}-{effort}[-{tail}]`), so ids
 * like `swe-2-medium`/`swe-2-high` collapse into one `swe-2` row that carries
 * `supportedReasoningEfforts`. Ids that do not match the pattern — bare
 * variants, legacy `MODEL_*` enums, `fusion-*` composites whose trailing
 * effort belongs to the sidekick model — pass through unchanged.
 */
export function groupDevinModelFamilies(rows: readonly ProviderModelInfo[]): {
  models: ProviderModelInfo[];
  families: DevinModelFamily[];
} {
  const families = new Map<string, DevinFamilyAccumulator>();
  const bareRowIndex = new Map<string, number>();
  const models: ProviderModelInfo[] = [];

  for (const row of rows) {
    if (row.id.startsWith("fusion-")) {
      models.push({ ...row });
      continue;
    }
    const match = row.id.match(DEVIN_EFFORT_SUFFIX);
    if (!match) {
      bareRowIndex.set(row.id, models.length);
      models.push({ ...row });
      continue;
    }
    const [, base, effortToken, tail = ""] = match;
    const effort = effortToken as ReasoningLevel;
    const familyId = `${base}${tail}`;
    let family = families.get(familyId);
    if (!family) {
      family = {
        id: familyId,
        name: stripEffortFromName(row.name, effort),
        group: row.group,
        supportedReasoningEfforts: [],
        effortModelIds: {},
        firstName: row.name,
        effortSeen: effort,
      };
      families.set(familyId, family);
    }
    family.effortModelIds[effort] = row.id;
  }

  const familyRows: ProviderModelInfo[] = [];
  for (const family of families.values()) {
    mergeBareModelRow(family, models, bareRowIndex);
    family.supportedReasoningEfforts = orderEfforts(Object.keys(family.effortModelIds) as ReasoningLevel[]);
    family.defaultReasoningEffort = family.implicitBareEffort
      ?? (family.supportedReasoningEfforts.includes("high")
        ? "high"
        : family.supportedReasoningEfforts[0]);
    familyRows.push({
      id: family.id,
      name: family.name,
      group: family.group,
      supportedReasoningEfforts: family.supportedReasoningEfforts,
      defaultReasoningEffort: family.defaultReasoningEffort,
    });
  }

  // Devin's own models lead the catalog; the picker groups by first-seen order.
  const combined = [...familyRows, ...models];
  const own = combined.filter((row) => row.group === "Cognition");
  const rest = combined.filter((row) => row.group !== "Cognition");
  return {
    models: [...own, ...rest],
    families: [...families.values()],
  };
}

/**
 * Resolves the concrete Devin catalog id for a family + effort selection.
 * Falls back to the bare variant, then the family's default effort, then the
 * raw model id so direct catalog ids pass through untouched.
 */
export function resolveDevinModelId(
  families: readonly DevinModelFamily[],
  modelId: string,
  effort: ReasoningLevel | undefined,
): string {
  const family = families.find(
    (entry) => entry.id === modelId
      || entry.bareModelId === modelId
      || Object.values(entry.effortModelIds).includes(modelId),
  );
  if (!family) return rewriteDevinEffortToken(modelId, effort);
  return resolveDevinFamilyModelId(family, modelId, effort);
}

/**
 * Catalog-free fallback: rewrites the effort token in place when the id
 * already carries one (`swe-2-high` + medium → `swe-2-medium`). Bare ids
 * pass through so an effort is never invented for them.
 */
function rewriteDevinEffortToken(modelId: string, effort: ReasoningLevel | undefined): string {
  if (!effort || modelId.startsWith("fusion-")) return modelId;
  const match = modelId.match(DEVIN_EFFORT_SUFFIX);
  return match ? `${match[1]}-${effort}${match[3] ?? ""}` : modelId;
}

function resolveDevinFamilyModelId(
  family: DevinModelFamily,
  modelId: string,
  effort: ReasoningLevel | undefined,
): string {
  if (effort && family.effortModelIds[effort]) return family.effortModelIds[effort];
  if (!effort && modelId !== family.id) return modelId;
  const defaultId = family.defaultReasoningEffort
    ? family.effortModelIds[family.defaultReasoningEffort]
    : undefined;
  return (modelId === family.id ? family.bareModelId : undefined) ?? defaultId ?? family.bareModelId ?? modelId;
}
