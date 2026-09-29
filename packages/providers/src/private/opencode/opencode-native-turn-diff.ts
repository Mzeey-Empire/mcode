import { createTextPatch } from "@mcode/shared";

/** Largest accepted native aggregate; matches the server-side turn-diff bound. */
const MAX_NATIVE_PATCH_BYTES = 2_097_152;
/** Largest retained per-file evidence before the whole aggregate is rejected. */
const MAX_FILE_EVIDENCE_BYTES = 2_097_152;
/** Largest retained file count before the whole aggregate is rejected. */
const MAX_TRACKED_FILES = 256;

/** One upstream `session.diff` file entry (SnapshotFileDiff). */
export interface OpenCodeFileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

export type OpenCodeNativeTurnDiffResult =
  | { state: "snapshot"; patch: string }
  | { state: "indeterminate-empty" }
  | { state: "rejected" };

type FileStatus = "added" | "deleted" | "modified";

interface ValidatedEntry {
  file: string;
  patch: string;
  status: FileStatus;
}

/**
 * Builds one complete native patch from upstream `session.diff` event entries.
 * Upstream diffs are computed from its own step-start/step-finish snapshots, so
 * they carry agent-attributed evidence; a same-file user edit made outside the
 * agent never appears in them.
 */
export class OpenCodeNativeTurnDiff {
  private readonly files = new Map<string, { patch: string; status: FileStatus }>();
  private contentBytes = 0;
  private rejected = false;

  /**
   * Fold one `session.diff` event into the aggregate. Returns null when the
   * event carries no information (an empty list before any evidence). An
   * empty list after evidence means upstream reverted to net-zero, which is
   * indeterminate-empty: the service reconciles it against file effects.
   */
  observe(entries: readonly unknown[]): OpenCodeNativeTurnDiffResult | null {
    if (this.rejected) return { state: "rejected" };
    if (!Array.isArray(entries)) return this.reject();
    if (entries.length === 0) return this.observeEmpty();
    for (const entry of entries) {
      if (!this.addEntry(entry)) return this.reject();
    }
    return this.aggregate();
  }

  private observeEmpty(): OpenCodeNativeTurnDiffResult | null {
    if (this.files.size === 0) return null;
    this.files.clear();
    this.contentBytes = 0;
    return { state: "indeterminate-empty" };
  }

  private addEntry(raw: unknown): boolean {
    const entry = validateEntry(raw);
    if (!entry) return false;
    const previous = this.files.get(entry.file);
    if (!previous && this.files.size >= MAX_TRACKED_FILES) return false;
    const nextBytes = this.contentBytes - (previous ? Buffer.byteLength(previous.patch) : 0) + Buffer.byteLength(entry.patch);
    if (nextBytes > MAX_NATIVE_PATCH_BYTES) return false;
    this.files.set(entry.file, { patch: entry.patch, status: entry.status });
    this.contentBytes = nextBytes;
    return true;
  }

  private aggregate(): OpenCodeNativeTurnDiffResult | null {
    const patches: string[] = [];
    for (const [file, { patch, status }] of this.files) {
      const normalized = normalizeUpstreamPatch(file, patch, status);
      if (normalized === undefined) return this.reject();
      if (normalized !== null) patches.push(normalized);
    }
    if (patches.length === 0) return { state: "indeterminate-empty" };
    const patch = patches.join("");
    return Buffer.byteLength(patch) <= MAX_NATIVE_PATCH_BYTES ? { state: "snapshot", patch } : this.reject();
  }

  private reject(): OpenCodeNativeTurnDiffResult {
    this.rejected = true;
    this.files.clear();
    this.contentBytes = 0;
    return { state: "rejected" };
  }
}

/** Validate one untrusted upstream entry; binary rows (no patch) cannot become a text comparison. */
function validateEntry(raw: unknown): ValidatedEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.file !== "string" || !isSafeRelativePath(entry.file)) return null;
  if (typeof entry.patch !== "string" || Buffer.byteLength(entry.patch) > MAX_FILE_EVIDENCE_BYTES) return null;
  const status = parseStatus(entry.status);
  if (status === null) return null;
  return { file: entry.file, patch: entry.patch, status };
}

function parseStatus(value: unknown): FileStatus | null {
  if (value === undefined) return "modified";
  return value === "added" || value === "deleted" || value === "modified" ? value : null;
}

function isSafeRelativePath(file: string): boolean {
  if (file.length === 0 || file.length > 4096 || /[\x00-\x1f"\\]/.test(file)) return false;
  return file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Convert one upstream per-file patch into Mcode's validated `diff --git` shape.
 * Upstream emits `formatPatch(structuredPatch(...))` output: `Index:`/`====` headers,
 * absolute paths, and full-file context. Rebuilding from the parsed before/after
 * content keeps one canonical shape for every provider. Returns null for a net-zero
 * file and undefined when the patch cannot be trusted.
 */
function normalizeUpstreamPatch(
  file: string,
  patch: string,
  status: FileStatus,
): string | null | undefined {
  const full = parseFullFilePatch(patch);
  if (!full) return undefined;
  const kind = status === "added" ? "added" : status === "deleted" ? "removed" : "edited";
  return createTextPatch(file, full.before, full.after, kind);
}

interface FullFileContent {
  before: string;
  after: string;
}

interface PatchParseState {
  before: string[];
  after: string[];
  beforeNewline: boolean;
  afterNewline: boolean;
  expectedBefore: number;
  expectedAfter: number;
  sawHunk: boolean;
  inHunks: boolean;
  previous: "both" | "before" | "after" | undefined;
}

/**
 * Reconstruct before/after content from a full-context unified patch.
 * Upstream uses `context: Number.MAX_SAFE_INTEGER`, so every line of both
 * versions is present; anything else is rejected rather than trusted.
 */
function parseFullFilePatch(patch: string): FullFileContent | undefined {
  const lines = patch.split("\n");
  // A patch ending in a newline splits into a trailing empty element.
  if (lines.at(-1) === "") lines.pop();
  const state: PatchParseState = {
    before: [], after: [], beforeNewline: true, afterNewline: true,
    expectedBefore: 0, expectedAfter: 0, sawHunk: false, inHunks: false, previous: undefined,
  };
  for (const line of lines) {
    if (!consumePatchLine(state, line)) return undefined;
  }
  if (!state.sawHunk) return undefined;
  if (state.before.length !== state.expectedBefore || state.after.length !== state.expectedAfter) return undefined;
  return {
    before: joinLines(state.before, state.beforeNewline),
    after: joinLines(state.after, state.afterNewline),
  };
}

function consumePatchLine(state: PatchParseState, line: string): boolean {
  if (line.startsWith("@@ ")) return consumeHunkHeader(state, line);
  if (!state.inHunks) return true;
  if (line === "\\ No newline at end of file") return consumeNewlineMarker(state);
  return consumeContentLine(state, line);
}

function consumeHunkHeader(state: PatchParseState, line: string): boolean {
  // Upstream's full-context diff always yields exactly one hunk; a second
  // header means malformed evidence, not another range to merge.
  if (state.sawHunk) return false;
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!range) return false;
  // Only a hunk covering the whole file from line 1 yields complete
  // before/after content; a partial patch would silently truncate.
  if (!coversWholeFile(range[1]!, range[2]) || !coversWholeFile(range[3]!, range[4])) return false;
  state.expectedBefore += range[2] === undefined ? 1 : Number(range[2]);
  state.expectedAfter += range[4] === undefined ? 1 : Number(range[4]);
  state.inHunks = true;
  state.sawHunk = true;
  state.previous = undefined;
  return true;
}

function coversWholeFile(start: string, count: string | undefined): boolean {
  return start === "1" || (start === "0" && count === "0");
}

function consumeNewlineMarker(state: PatchParseState): boolean {
  if (state.previous === "both") {
    state.beforeNewline = false;
    state.afterNewline = false;
  } else if (state.previous === "before") {
    state.beforeNewline = false;
  } else if (state.previous === "after") {
    state.afterNewline = false;
  } else {
    return false;
  }
  return true;
}

function consumeContentLine(state: PatchParseState, line: string): boolean {
  const prefix = line[0];
  const text = line.slice(1);
  if (prefix === " ") {
    state.before.push(text);
    state.after.push(text);
    state.previous = "both";
  } else if (prefix === "-") {
    state.before.push(text);
    state.previous = "before";
  } else if (prefix === "+") {
    state.after.push(text);
    state.previous = "after";
  } else {
    return false;
  }
  return true;
}

/** Rebuild exact file text from patch lines plus the trailing-newline marker. */
function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  return trailingNewline ? `${joined}\n` : joined;
}
