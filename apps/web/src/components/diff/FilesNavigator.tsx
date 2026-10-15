import { Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ReviewFileChange } from "@mcode/contracts";
import { PullRequestFileTree } from "@/features/pull-requests";
import { Input } from "@/components/ui/input";

/** What both Files hosts need to show the comparison's changed files. */
export interface FilesNavigatorModel {
  readonly files: readonly ReviewFileChange[];
  /** File the diff is on; follows scrolling and every jump. */
  readonly activePath: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onActivate: (path: string) => void;
}

interface FilesNavigatorProps extends FilesNavigatorModel {
  /** Sits beside the filter, for a host's own control such as Refresh. */
  readonly trailing?: ReactNode;
  readonly autoFocusFilter?: boolean;
}

/** The filter and changed-file tree that the docked pane and the popover share. */
export function FilesNavigator({
  files,
  activePath,
  loading,
  error,
  onActivate,
  trailing,
  autoFocusFilter = false,
}: FilesNavigatorProps) {
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredFiles = useMemo(
    () =>
      normalizedSearch
        ? files.filter((file) =>
            `${file.previousPath ?? ""} ${file.path}`.toLocaleLowerCase().includes(normalizedSearch),
          )
        : files,
    [files, normalizedSearch],
  );

  return (
    <>
      <div className="flex h-11 shrink-0 items-center border-b border-border/35 px-2.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted/70"
          />
          <Input
            size="compact"
            value={search}
            maxLength={200}
            autoFocus={autoFocusFilter}
            aria-label="Search files"
            placeholder="Filter files"
            className="h-8 rounded-md bg-background/70 pl-7 font-mono text-xs"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {trailing}
      </div>
      <FilesNavigatorBody
        files={files}
        filteredFiles={filteredFiles}
        activePath={activePath}
        loading={loading}
        error={error}
        searchActive={normalizedSearch.length > 0}
        onActivate={onActivate}
      />
    </>
  );
}

function FilesNavigatorBody({
  files,
  filteredFiles,
  activePath,
  loading,
  error,
  searchActive,
  onActivate,
}: FilesNavigatorModel & {
  readonly filteredFiles: readonly ReviewFileChange[];
  readonly searchActive: boolean;
}) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center" role="status">
        <span className="font-mono text-caption uppercase tracking-[0.18em] text-muted/50">Loading files</span>
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="px-3 py-4 text-xs text-destructive">
        {error}
      </p>
    );
  }
  if (filteredFiles.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
        <span aria-hidden className="font-mono text-2xl text-muted/15">
          ⊘
        </span>
        <p className="font-mono text-caption uppercase tracking-[0.18em] text-muted/40">
          {files.length === 0 ? "No changed files" : "No matching files"}
        </p>
      </div>
    );
  }
  return (
    <PullRequestFileTree
      reviewFiles={filteredFiles}
      activePath={activePath}
      searchActive={searchActive}
      className="min-h-0 flex-1"
      ariaLabel="Files"
      onActivate={onActivate}
    />
  );
}
