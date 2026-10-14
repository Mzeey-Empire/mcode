import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ReviewFileChange } from "@mcode/contracts";
import { ChevronRight, Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  COMMIT_FLAT_MAX_FILES,
  basenameOf,
  checkedState,
  dirnameOf,
  isChecked,
  isFolderOpen,
  layoutCommitFiles,
  type CommitChoices,
  type CommitFolder,
} from "@/lib/commit-selection";
import { cn } from "@/lib/utils";
import { DiffStat } from "./DiffStat";

const LIST_MAX_HEIGHT_PX = 228;

export interface CommitFileListProps {
  /** Every uncommitted file, unfiltered. */
  readonly files: readonly ReviewFileChange[];
  readonly choices: CommitChoices;
  readonly onSetChecked: (files: readonly ReviewFileChange[], checked: boolean) => void;
  /** Review's file in view; its folder stays open when the rest start collapsed. */
  readonly activePath: string | null;
  /** True while a commit is in flight, so the selection cannot change under it. */
  readonly locked: boolean;
}

/**
 * The sheet's file list: a select-all row, then every uncommitted file with a
 * checkbox. Flat for 10 files or fewer; above that, grouped by folder with tri-state
 * folder checkboxes and a filter.
 */
export function CommitFileList({ files, choices, onSetChecked, activePath, locked }: CommitFileListProps) {
  const [filter, setFilter] = useState("");
  const [folderToggles, setFolderToggles] = useState<Readonly<Record<string, boolean>>>({});
  const filtering = filter.trim() !== "";
  const layout = layoutCommitFiles(files, filter);
  const visible = layout.kind === "flat" ? layout.files : [...layout.folders.flatMap((folder) => folder.files), ...layout.rootFiles];
  const checkedCount = files.filter((file) => isChecked(file, choices)).length;
  const activeDir = activePath === null ? null : dirnameOf(activePath);

  return (
    <div className="flex flex-col gap-1 rounded-composer bg-field p-2" data-testid="commit-file-list">
      <div className="flex h-8 items-center gap-3 px-2">
        <Checkbox
          aria-label="Select all files"
          checked={checkedState(visible, choices)}
          disabled={locked || visible.length === 0}
          onCheckedChange={(next) => onSetChecked(visible, next)}
        />
        <span className="min-w-0 flex-1 text-body-small text-muted">
          {checkedCount} of {files.length} files
        </span>
        {files.length > COMMIT_FLAT_MAX_FILES ? <FilterField value={filter} onChange={setFilter} /> : null}
      </div>
      <ScrolledRows resetKey={`${layout.kind}:${visible.length}`}>
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-body-small text-muted">No files match</p>
        ) : layout.kind === "flat" ? (
          layout.files.map((file) => (
            <FileRow key={file.path} file={file} choices={choices} locked={locked} showFolder onSetChecked={onSetChecked} />
          ))
        ) : (
          <>
            {layout.folders.map((folder) => {
              const open = isFolderOpen(folder, layout, folderToggles, activeDir, filtering);
              return (
                <FolderGroup
                  key={folder.dir}
                  folder={folder}
                  open={open}
                  choices={choices}
                  locked={locked}
                  onToggleOpen={() => setFolderToggles((current) => ({ ...current, [folder.dir]: !open }))}
                  onSetChecked={onSetChecked}
                />
              );
            })}
            {layout.rootFiles.map((file) => (
              <FileRow key={file.path} file={file} choices={choices} locked={locked} onSetChecked={onSetChecked} />
            ))}
          </>
        )}
      </ScrolledRows>
    </div>
  );
}

function FilterField({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <div className="relative w-40 shrink-0">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
      <Input
        size="compact"
        value={value}
        placeholder="Filter files"
        aria-label="Filter files"
        onChange={(event) => onChange(event.target.value)}
        className="pl-8"
      />
    </div>
  );
}

function ScrolledRows({ children, resetKey }: { readonly children: ReactNode; readonly resetKey: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = () => {
    const element = viewport.current;
    if (element) setMoreBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
  };
  useLayoutEffect(measure, [resetKey]);
  return (
    <ScrollArea
      className="min-h-0"
      viewportRef={viewport}
      viewportProps={{ onScroll: measure }}
      viewportClassName={cn(
        "flex flex-col",
        moreBelow && "[mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]",
      )}
      style={{ maxHeight: LIST_MAX_HEIGHT_PX }}
    >
      {children}
    </ScrollArea>
  );
}

interface RowShared {
  readonly choices: CommitChoices;
  readonly locked: boolean;
  readonly onSetChecked: (files: readonly ReviewFileChange[], checked: boolean) => void;
}

function FolderGroup({
  folder,
  open,
  choices,
  locked,
  onToggleOpen,
  onSetChecked,
}: RowShared & { readonly folder: CommitFolder; readonly open: boolean; readonly onToggleOpen: () => void }) {
  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-3 rounded-menu px-2 hover:bg-hover">
        <Checkbox
          aria-label={`Select ${folder.dir}`}
          checked={checkedState(folder.files, choices)}
          disabled={locked}
          onCheckedChange={(next) => onSetChecked(folder.files, next)}
        />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${folder.dir}`}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-body-small text-ink"
        >
          <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-90")} />
          <span className="text-fade min-w-0 whitespace-nowrap">{folder.dir}</span>
          <span className="shrink-0 text-caption text-muted">{folder.files.length}</span>
        </button>
        <DiffStat additions={folder.additions} deletions={folder.deletions} />
      </div>
      {open
        ? folder.files.map((file) => (
            <FileRow key={file.path} file={file} choices={choices} locked={locked} indented onSetChecked={onSetChecked} />
          ))
        : null}
    </>
  );
}

function FileRow({
  file,
  choices,
  locked,
  onSetChecked,
  indented = false,
  showFolder = false,
}: RowShared & { readonly file: ReviewFileChange; readonly indented?: boolean; readonly showFolder?: boolean }) {
  const deleted = file.changeType === "deleted";
  const tag = fileTag(file);
  const folder = dirnameOf(file.path);
  return (
    <label className={cn("flex h-8 shrink-0 cursor-pointer items-center gap-3 rounded-menu px-2 hover:bg-hover", indented && "pl-9")}>
      <Checkbox
        checked={isChecked(file, choices)}
        disabled={locked}
        onCheckedChange={(next) => onSetChecked([file], next)}
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2 whitespace-nowrap">
        <span className={cn("shrink-0 text-body-small font-medium text-ink", deleted && "line-through")}>
          {basenameOf(file.path)}
        </span>
        {showFolder && folder !== "" ? <span className="text-fade min-w-0 text-caption text-muted">{folder}</span> : null}
        {tag ? <span className={cn("shrink-0 text-caption", tag.tone)}>{tag.label}</span> : null}
      </span>
      <FileStat file={file} />
    </label>
  );
}

function FileStat({ file }: { readonly file: ReviewFileChange }) {
  return file.binary ? null : <DiffStat additions={file.additions ?? 0} deletions={file.deletions ?? 0} />;
}

function fileTag(file: ReviewFileChange): { label: string; tone: string } | null {
  if (file.changeType === "deleted") return { label: "deleted", tone: "text-[var(--diff-remove-strong)]" };
  if (file.untracked || file.changeType === "added") return { label: "new", tone: "text-[var(--diff-add-strong)]" };
  if (file.changeType === "renamed") return { label: "renamed", tone: "text-muted" };
  return null;
}
