/** Correlation identifiers retained independently of bounded payloads. */
export interface DiagIds {
  readonly th?: string;
  readonly turn?: string;
  readonly ws?: string;
}

/** A span's terminal result. */
export type DiagOutcome = "ok" | "error" | "cancelled" | "rejected";

type RecordBase = DiagIds & {
  t: number;
  n: number;
  ch: string;
  d?: unknown;
};

/** The shared, self-describing JSONL wire format. */
export type DiagRecord =
  | (RecordBase & { k: "ev" })
  | (RecordBase & { k: "beg"; sp: string; exp: number | null })
  | (RecordBase & { k: "end"; sp: string; ok: DiagOutcome; ms?: number })
  | (RecordBase & {
      k: "run";
      ch: "diag";
      run: string;
      pid: number;
      state: "on" | "off" | "dropped";
      dropped?: number;
    });

const ID_KEYS = ["th", "turn", "ws"];
const OUTCOMES = ["ok", "error", "cancelled", "rejected"];
const RUN_STATES = ["on", "off", "dropped"];

function hasString(value: object, key: string): boolean {
  return typeof Reflect.get(value, key) === "string";
}

function hasNumber(value: object, key: string): boolean {
  return Number.isFinite(Reflect.get(value, key));
}

function hasOptionalNumber(value: object, key: string): boolean {
  if (!(key in value)) return true;
  return hasNumber(value, key);
}

function hasOneOf(value: object, key: string, options: readonly string[]): boolean {
  return options.includes(Reflect.get(value, key));
}

function hasValidIds(value: object): boolean {
  return ID_KEYS.every((key) => !(key in value) || hasString(value, key));
}

function isValidBegin(value: object): boolean {
  if (!hasString(value, "sp")) return false;
  const budget = Reflect.get(value, "exp");
  return budget === null || hasNumber(value, "exp");
}

function isValidEnd(value: object): boolean {
  return (
    hasString(value, "sp") &&
    hasOneOf(value, "ok", OUTCOMES) &&
    hasOptionalNumber(value, "ms")
  );
}

function isValidRun(value: object): boolean {
  return (
    Reflect.get(value, "ch") === "diag" &&
    hasString(value, "run") &&
    hasNumber(value, "pid") &&
    hasOneOf(value, "state", RUN_STATES) &&
    hasOptionalNumber(value, "dropped")
  );
}

function isValidVariant(value: object): boolean {
  switch (Reflect.get(value, "k")) {
    case "ev":
      return true;
    case "beg":
      return isValidBegin(value);
    case "end":
      return isValidEnd(value);
    case "run":
      return isValidRun(value);
    default:
      return false;
  }
}

function isDiagRecord(value: unknown): value is DiagRecord {
  if (!value || typeof value !== "object") return false;
  return (
    hasNumber(value, "t") &&
    hasNumber(value, "n") &&
    hasString(value, "ch") &&
    hasValidIds(value) &&
    isValidVariant(value)
  );
}

/** Invalid or torn records cannot prevent reading the retained evidence. */
export function parseDiagLine(line: string): DiagRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isDiagRecord(parsed) ? parsed : undefined;
}
