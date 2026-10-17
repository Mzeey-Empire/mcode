import { useCallback, useEffect, useState } from "react";
import { ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PICKER_PANEL_CLASS, Picker, type PickerRow, type PickerStatus } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebouncedQuery } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { buildServerImageUrl } from "@/lib/server-image-url";
import { getTransport } from "@/transport";

interface Candidates {
  readonly files: readonly string[];
  readonly total: number;
}

type CandidatesState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly query: string; readonly candidates: Candidates }
  | { readonly kind: "failed"; readonly detail: string };

function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

function useIconCandidates(workspaceId: string, query: string, retryKey: number): CandidatesState {
  const [state, setState] = useState<CandidatesState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    getTransport()
      .listProjectIconCandidates(workspaceId, query)
      .then(
        (candidates) => { if (!cancelled) setState({ kind: "ready", query, candidates }); },
        (error: unknown) => {
          if (!cancelled) setState({ kind: "failed", detail: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => { cancelled = true; };
  }, [workspaceId, query, retryKey]);
  return state;
}

function pickerStatus(state: CandidatesState): PickerStatus {
  if (state.kind === "failed") return { failed: "Image files could not be listed", detail: state.detail };
  return state.kind;
}

function Thumbnail({ workspaceId, path }: { readonly workspaceId: string; readonly path: string }) {
  const [failed, setFailed] = useState(false);
  const src = failed
    ? null
    : buildServerImageUrl(`/workspace-images/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ path, use: "icon" })}`);
  if (!src) return <ImageIcon aria-hidden className="size-4" />;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className="-mx-0.5 size-5 max-w-none shrink-0 rounded-[5px] object-contain"
    />
  );
}

interface ProjectIconPickerListProps {
  readonly workspaceId: string;
  readonly chosenPath: string | null;
  readonly onPick: (path: string) => void;
}

function ProjectIconPickerList({ workspaceId, chosenPath, onPick }: ProjectIconPickerListProps) {
  const [query, setQuery] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const searched = useDebouncedQuery(query);
  const state = useIconCandidates(workspaceId, searched, retryKey);
  const renderRow = useCallback((path: string): PickerRow => {
    const { name, folder } = splitPath(path);
    return { key: path, name, tag: folder || undefined, icon: <Thumbnail workspaceId={workspaceId} path={path} /> };
  }, [workspaceId]);
  const candidates = state.kind === "ready" ? state.candidates : null;
  // The list keeps the previous results until the new ones arrive, so Enter must not pick from them.
  const settled = state.kind === "ready" && state.query === query;
  return (
    <Picker
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search image files"
      items={candidates?.files ?? []}
      total={candidates?.total ?? null}
      status={pickerStatus(state)}
      onRetry={() => setRetryKey((key) => key + 1)}
      selectedKey={chosenPath ?? undefined}
      renderItem={renderRow}
      onSelect={(path) => { if (settled) onPick(path); }}
    />
  );
}

/** Props for {@link ProjectIconPicker}. */
export interface ProjectIconPickerProps {
  readonly workspaceId: string;
  /** The saved icon path, marked in the list, or null when the icon is automatic. */
  readonly chosenPath: string | null;
  /** Called with the workspace-relative path the user picked; the popover closes after it. */
  readonly onPick: (path: string) => void;
}

/** The "Choose file" button and the searchable popover of the project's image files. */
export function ProjectIconPicker({ workspaceId, chosenPath, onPick }: ProjectIconPickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="subtle" shape="round" className="text-[13px]/[18px] font-medium" aria-haspopup="dialog">Choose file</Button>}
      />
      <PopoverContent align="end" side="bottom" sideOffset={8} className={cn(PICKER_PANEL_CLASS, "w-[min(92vw,34rem)] p-1.5")}>
        {open ? (
          <ProjectIconPickerList
            workspaceId={workspaceId}
            chosenPath={chosenPath}
            onPick={(path) => {
              onPick(path);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
