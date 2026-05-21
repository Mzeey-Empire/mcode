/**
 * Heuristic labels for Cursor CLI model ids when live catalog and snapshot miss.
 * Mirrors naming from `agent models` (Composer, Codex, Opus 4.7 1M High Thinking, etc.).
 */

const COMPOSER_PATTERN = /^composer-(\d+(?:\.\d+)?)(?:-(.+))?$/;

const TOKEN_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  none: "None",
  fast: "Fast",
  thinking: "Thinking",
  mini: "Mini",
  nano: "Nano",
  codex: "Codex",
  build: "Build",
  pro: "Pro",
  flash: "Flash",
};

/** Title-cases a single hyphenated word. */
function titleCaseWord(word: string): string {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Maps Claude tail segments; matches `agent models` effort/thinking ordering. */
function formatClaudeTailSegments(tail: string): string[] {
  const thinkingFirst = tail.match(/^thinking-(.+)$/);
  if (thinkingFirst) {
    return [...formatTailSegments(thinkingFirst[1]!), "Thinking"];
  }
  if (tail.endsWith("-thinking")) {
    const effort = tail.slice(0, -"-thinking".length);
    return [...formatTailSegments(effort), "Thinking"];
  }
  const words = formatTailSegments(tail);
  // `-medium` on Claude 4.6 ids denotes 1M context; CLI labels omit the word "Medium".
  if (words.length === 1 && words[0] === "Medium") return [];
  return words;
}

/** Maps tail segments (effort, thinking, fast) to display words. */
function formatTailSegments(tail: string): string[] {
  const parts = tail.split("-").filter(Boolean);
  const words: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "extra" && parts[i + 1] === "high") {
      words.push("Extra High");
      i += 1;
      continue;
    }
    words.push(TOKEN_LABELS[parts[i]!] ?? titleCaseWord(parts[i]!));
  }
  return words;
}

/** Returns true when the id uses Cursor CLI naming (not native Mcode Claude ids). */
export function isCursorCliModelId(modelId: string): boolean {
  if (/^claude-(opus|sonnet|haiku)-\d+-\d+-\d{6,}/.test(modelId)) return false;
  if (/^claude-(opus|sonnet|haiku)-\d+-\d+/.test(modelId)) return true;
  if (/^claude-\d+\.\d+-(opus|sonnet|haiku)-/.test(modelId)) return true;
  if (/^claude-\d+-\d+-(opus|sonnet|haiku)-/.test(modelId)) return true;
  if (/^claude-\d+-(opus|sonnet|haiku)/.test(modelId)) return true;
  return /^(auto|composer-|gpt-|grok-|gemini-|kimi-)/.test(modelId);
}

/**
 * Formats a Cursor CLI model id into a display label, or null if the id is not recognized.
 */
export function formatCursorCliModelId(modelId: string): string | null {
  const id = modelId.trim();
  if (!id) return null;

  if (id === "auto") return "Auto";

  const composerMatch = id.match(COMPOSER_PATTERN);
  if (composerMatch) {
    const [, version, tier] = composerMatch;
    if (tier) return `Composer ${version} ${titleCaseWord(tier)}`;
    return `Composer ${version}`;
  }

  const claude46dot = id.match(/^claude-(\d+)\.(\d+)-(opus|sonnet|haiku)-(.+)$/);
  if (claude46dot) {
    const [, major, minor, tier, tail] = claude46dot;
    const base = `${titleCaseWord(tier)} ${major}.${minor}`;
    const oneM = id.includes("-medium") ? ["1M"] : [];
    return [base, ...oneM, ...formatClaudeTailSegments(tail)].join(" ");
  }

  const claude46 = id.match(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)-(.+)$/);
  if (claude46) {
    const [, major, minor, tier, tail] = claude46;
    const base = `${titleCaseWord(tier)} ${major}.${minor}`;
    const oneM = id.includes("-medium") ? ["1M"] : [];
    return [base, ...oneM, ...formatClaudeTailSegments(tail)].join(" ");
  }

  const claude47 = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-(.+))?$/);
  if (claude47) {
    const [, tier, major, minor, tail] = claude47;
    const base = `${titleCaseWord(tier)} ${major}.${minor}`;
    const oneM = major === "4" && minor === "7" && tier === "opus" ? ["1M"] : [];
    const tailWords = tail ? formatClaudeTailSegments(tail) : [];
    return [base, ...oneM, ...tailWords].join(" ");
  }

  const claude4 = id.match(/^claude-(\d+)-(opus|sonnet|haiku)(?:-(.+))?$/);
  if (claude4) {
    const [, major, tier, tail] = claude4;
    const base = `${titleCaseWord(tier)} ${major}`;
    const tailWords = tail ? formatTailSegments(tail) : [];
    return [base, ...tailWords].join(" ");
  }

  if (id.startsWith("gpt-")) {
    return formatGptCursorModelId(id);
  }

  if (id.startsWith("grok-")) {
    const tail = id.slice(5);
    return `Grok ${formatTailSegments(tail).join(" ")}`.trim();
  }

  if (id.startsWith("gemini-")) {
    const tail = id.slice(7);
    return `Gemini ${formatTailSegments(tail).join(" ")}`.trim();
  }

  if (id.startsWith("kimi-")) {
    return id
      .split("-")
      .map(titleCaseWord)
      .join(" ");
  }

  return null;
}

/**
 * Parses Cursor `gpt-*` model ids (GPT, Codex, Mini, Nano, Max variants).
 */
function formatGptCursorModelId(id: string): string {
  const body = id.slice(4);
  const parts = body.split("-").filter(Boolean);
  if (parts.length === 0) return "GPT";

  let version = parts[0] ?? "";
  let idx = 1;
  if (parts[1] && /^\d+$/.test(parts[1])) {
    version = `${parts[0]}.${parts[1]}`;
    idx = 2;
  }

  const rest = parts.slice(idx);
  const isCodex = rest.includes("codex");
  const hasMaxTier = rest.includes("max");
  const oneM =
    rest.includes("medium") && !rest.includes("mini") && !rest.includes("nano") ? ["1M"] : [];

  const prefix = isCodex ? `Codex ${version}` : `GPT-${version}`;
  const tailParts = rest.filter(
    (p) => p !== "codex" && p !== "max" && !(p === "medium" && oneM.length > 0),
  );
  const tail = formatTailSegments(tailParts.join("-"));
  const maxWord = hasMaxTier ? ["Max"] : [];

  return [prefix, ...maxWord, ...oneM, ...tail].filter(Boolean).join(" ");
}
