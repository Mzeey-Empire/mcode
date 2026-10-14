import type { GitCommitFile, ReviewFileChange } from "@mcode/contracts";
import type { CheckboxChecked } from "@/components/ui/checkbox";

/** Past this many files the sheet groups by folder and offers a filter. */
export const COMMIT_FLAT_MAX_FILES = 10;
/** Past this many rows (files plus folder rows) folders start collapsed. */
export const COMMIT_COLLAPSE_ROW_THRESHOLD = 12;

/** The user's explicit checkbox choices by path; a path with no choice takes its default. */
export type CommitChoices = Readonly<Record<string, boolean>>;

/** One folder row and the files under it. */
export interface CommitFolder {
  readonly dir: string;
  readonly files: readonly ReviewFileChange[];
  readonly additions: number;
  readonly deletions: number;
}

/** What the file list renders: a flat list, or folders followed by files that sit at the repo root. */
export type CommitListLayout =
  | { readonly kind: "flat"; readonly files: readonly ReviewFileChange[] }
  | { readonly kind: "grouped"; readonly folders: readonly CommitFolder[]; readonly rootFiles: readonly ReviewFileChange[] };

const PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function comparePaths(a: ReviewFileChange, b: ReviewFileChange): number {
  return PATH_COLLATOR.compare(a.path, b.path);
}

/** Folder of a repo-relative path; empty for a file at the root. */
export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Last segment of a repo-relative path. */
export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Tracked files by path, then untracked files by path. */
export function orderCommitFiles(files: readonly ReviewFileChange[]): ReviewFileChange[] {
  return [...files].sort((a, b) => Number(a.untracked) - Number(b.untracked) || comparePaths(a, b));
}

/** A path nobody has toggled is checked unless git does not track it yet. */
export function isChecked(file: ReviewFileChange, choices: CommitChoices): boolean {
  return choices[file.path] ?? !file.untracked;
}

/** The checked files, in the order given. */
export function checkedFiles(files: readonly ReviewFileChange[], choices: CommitChoices): ReviewFileChange[] {
  return files.filter((file) => isChecked(file, choices));
}

/** Request shape for the checked files; a rename carries both sides so the old path's deletion lands too. */
export function toCommitFiles(files: readonly ReviewFileChange[]): GitCommitFile[] {
  return files.map(({ path, previousPath }) => ({ path, previousPath }));
}

/** Checked state of a parent over its files: all, none, or mixed. */
export function checkedState(files: readonly ReviewFileChange[], choices: CommitChoices): CheckboxChecked {
  const checked = files.filter((file) => isChecked(file, choices)).length;
  if (checked === 0) return false;
  return checked === files.length ? true : "mixed";
}

/** Choices with every given file set to `checked`. */
export function withChecked(
  choices: CommitChoices,
  files: readonly ReviewFileChange[],
  checked: boolean,
): CommitChoices {
  const next = { ...choices };
  for (const file of files) next[file.path] = checked;
  return next;
}

/** Whether the filter text matches a path, ignoring case. */
export function matchesFilter(file: ReviewFileChange, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle === "" || file.path.toLowerCase().includes(needle);
}

function folderOf(dir: string, files: readonly ReviewFileChange[]): CommitFolder {
  return {
    dir,
    files,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
}

/**
 * Lays out the list. The flat-versus-grouped choice follows the full file count so
 * filtering never flips a grouped list flat. Folders holding only untracked files
 * sort after the rest, and root files come last, so untracked files trail.
 */
export function layoutCommitFiles(allFiles: readonly ReviewFileChange[], filter: string): CommitListLayout {
  const ordered = orderCommitFiles(allFiles).filter((file) => matchesFilter(file, filter));
  if (allFiles.length <= COMMIT_FLAT_MAX_FILES) return { kind: "flat", files: ordered };
  const byDir = new Map<string, ReviewFileChange[]>();
  const rootFiles: ReviewFileChange[] = [];
  for (const file of ordered) {
    const dir = dirnameOf(file.path);
    if (dir === "") {
      rootFiles.push(file);
      continue;
    }
    byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }
  const folders = [...byDir].map(([dir, files]) => folderOf(dir, files));
  const rank = (folder: CommitFolder) => Number(folder.files.every((file) => file.untracked));
  folders.sort((a, b) => rank(a) - rank(b) || PATH_COLLATOR.compare(a.dir, b.dir));
  return { kind: "grouped", folders, rootFiles };
}

/** Whether a folder shows its files: the user's toggle wins, then the default for the list's size. */
export function isFolderOpen(
  folder: CommitFolder,
  layout: Extract<CommitListLayout, { kind: "grouped" }>,
  overrides: Readonly<Record<string, boolean>>,
  activeDir: string | null,
  filtering: boolean,
): boolean {
  const toggled = overrides[folder.dir];
  if (toggled !== undefined) return toggled;
  if (filtering) return true;
  const rows = layout.folders.reduce((sum, entry) => sum + 1 + entry.files.length, layout.rootFiles.length);
  return rows <= COMMIT_COLLAPSE_ROW_THRESHOLD || folder.dir === activeDir;
}
