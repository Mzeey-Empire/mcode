import type { SettingDef } from "./setting-def";

/** One searchable entry: the def plus its page label, built once from SETTINGS_PAGES. */
export interface IndexedSetting {
  readonly def: SettingDef;
  readonly pageLabel: string;
}

/** A search result with its score; higher ranks first. */
export interface SettingMatch {
  readonly entry: IndexedSetting;
  readonly score: number;
}

const STOP_WORDS = new Set(
  "a an the my is are be being get gets got too so why how do does i it its to of for in on with and or not when what".split(" "),
);

const LABEL_WEIGHT = 4;
const SYNONYM_WEIGHT = 3;
const PROBLEM_WEIGHT = 3;
const PAGE_WEIGHT = 1.5;
const GROUP_WEIGHT = 1.2;
const HINT_WEIGHT = 1;
/** A match at or above this weight came from the setting itself or its page, not only its group or hint. */
const DIRECT_WEIGHT = 1.5;
const PREFIX_FACTOR = 0.9;
const MIN_PREFIX_LENGTH = 3;
const LABEL_PHRASE_BONUS = 2;

const stem = (word: string) => (word.length > 4 ? word.replace(/(ing|ed|es|s)$/, "") : word);

const normalize = (text: string) => text.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

const tokenize = (text: string | undefined) =>
  normalize(text ?? "")
    .split(/[^a-z0-9.+]+/)
    .filter((token) => token !== "" && !STOP_WORDS.has(token))
    .map(stem);

interface ScoredEntry extends SettingMatch {
  readonly direct: boolean;
}

type WeightedField = readonly [readonly string[], number];

function scoreToken(token: string, fields: readonly WeightedField[]): { best: number; exactFields: number } {
  let best = 0;
  let exactFields = 0;
  // A whole-word match outranks a prefix match, so "open" ranks "open-in" above "OpenCode".
  for (const [fieldTokens, weight] of fields) {
    if (fieldTokens.includes(token)) {
      best = Math.max(best, weight);
      exactFields++;
    } else if (token.length >= MIN_PREFIX_LENGTH && fieldTokens.some((field) => field.startsWith(token))) {
      best = Math.max(best, weight * PREFIX_FACTOR);
    }
  }
  return { best, exactFields };
}

function scoreEntry(entry: IndexedSetting, query: string, queryTokens: readonly string[]): ScoredEntry | null {
  const { def } = entry;
  const fields: readonly WeightedField[] = [
    [tokenize(def.label), LABEL_WEIGHT],
    [tokenize(def.synonyms), SYNONYM_WEIGHT],
    [tokenize(def.problems), PROBLEM_WEIGHT],
    [tokenize(entry.pageLabel), PAGE_WEIGHT],
    [tokenize(def.group?.title), GROUP_WEIGHT],
    [tokenize(def.hint), HINT_WEIGHT],
  ];
  let score = 0;
  let hits = 0;
  let exact = 0;
  let direct = false;
  for (const token of queryTokens) {
    const { best, exactFields } = scoreToken(token, fields);
    exact += exactFields;
    if (best > 0) {
      hits++;
      score += best;
    }
    if (best >= DIRECT_WEIGHT) direct = true;
  }
  if (hits === 0) return null;
  // Stop words drop "in" from "open in", so the whole phrase found in a label ("open-in") breaks the tie.
  if (normalize(def.label).includes(normalize(query))) score += LABEL_PHRASE_BONUS;
  const fraction = hits / queryTokens.length;
  if (fraction < 0.5 && queryTokens.length !== 1) return null;
  // A row found only by prefix ("code" in "Codex") ranks below every row with a whole-word match.
  return { entry, score: score * fraction * (exact > 0 ? 1 : 0.5), direct };
}

/**
 * The prototype's scoring, ported unchanged: field weights label 4, synonyms 3, problems 3, page 1.5, group 1.2, hint 1;
 * whole word over prefix (prefix needs 3+ characters, x0.9); +2 when the query phrase is in the label; keep when half the
 * tokens hit; prefix-only halves. Group- or hint-only matches drop when any direct match exists. Equal scores keep index order.
 * Skips defs whose exists() is false. Returns [] for an empty or stop-word-only query.
 */
export function searchSettings(query: string, index: readonly IndexedSetting[]): readonly SettingMatch[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const scored: ScoredEntry[] = [];
  for (const entry of index) {
    if (entry.def.exists && !entry.def.exists()) continue;
    const match = scoreEntry(entry, query, queryTokens);
    if (match) scored.push(match);
  }
  // A group name ("Presentation") only finds settings when nothing else matches; a page name still finds its whole page.
  const kept = scored.some((match) => match.direct) ? scored.filter((match) => match.direct) : scored;
  return kept.sort((a, b) => b.score - a.score).map(({ entry, score }) => ({ entry, score }));
}

/** Location path parts: "Threads › Closing and cleanup", or "Providers › Claude" for per-provider rows. */
export function settingLocation(entry: IndexedSetting): readonly string[] {
  const group = entry.def.group?.title;
  return group ? [entry.pageLabel, group] : [entry.pageLabel];
}
