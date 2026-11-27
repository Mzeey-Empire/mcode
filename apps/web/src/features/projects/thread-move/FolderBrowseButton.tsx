import { useCallback, useEffect, useMemo, useState } from "react";
import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import type { FilesystemBrowseResult } from "@mcode/contracts/ws/methods";
import { Button } from "@/components/ui/button";
import { Picker, PICKER_PANEL_CLASS, type PickerRow, type PickerStatus } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { joinPaths } from "@/lib/path";
import { getTransport } from "@/transport";

const PARENT_ROW_KEY = "..";

type FolderRowItem = { readonly kind: "parent"; readonly path: string } | { readonly kind: "folder"; readonly name: string };

/** A listing read for one request key; a null result is a read that failed. */
interface Listing {
  readonly key: string;
  readonly result: FilesystemBrowseResult | null;
}

/** The server's listing of one folder. A failed read is a listing without a result, so the picker can offer a retry. */
function useFolderListing(path: string, attempt: number): { readonly result: FilesystemBrowseResult | null; readonly loading: boolean } {
  const key = `${attempt}\u0000${path}`;
  const [listing, setListing] = useState<Listing | null>(null);
  useEffect(() => {
    let current = true;
    getTransport().filesystemBrowse(path).then(
      (result) => { if (current) setListing({ key, result }); },
      () => { if (current) setListing({ key, result: null }); },
    );
    return () => { current = false; };
  }, [key, path]);
  const settled = listing?.key === key ? listing : null;
  return { result: settled?.result ?? null, loading: settled === null };
}

function folderRow(item: FolderRowItem): PickerRow {
  const icon = item.kind === "parent" ? <CornerLeftUpIcon aria-hidden className="size-4" /> : <FolderIcon aria-hidden className="size-4" />;
  return item.kind === "parent"
    ? { key: PARENT_ROW_KEY, name: "Parent folder", icon }
    : { key: item.name, name: item.name, icon, mono: true };
}

function folderItems(result: FilesystemBrowseResult | null, query: string): readonly FolderRowItem[] {
  if (!result) return [];
  const needle = query.trim().toLowerCase();
  const folders = result.entries
    .filter((entry) => entry.isDir && entry.name.toLowerCase().includes(needle))
    .map((entry): FolderRowItem => ({ kind: "folder", name: entry.name }));
  return result.parent && needle === "" ? [{ kind: "parent", path: result.parent }, ...folders] : folders;
}

interface FolderBrowserProps {
  readonly startPath: string;
  readonly onPick: (path: string) => void;
}

function FolderBrowser({ startPath, onPick }: FolderBrowserProps) {
  const [path, setPath] = useState(startPath);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { result, loading } = useFolderListing(path, attempt);
  const items = useMemo(() => folderItems(result, query), [result, query]);
  const status: PickerStatus = loading ? "loading" : result ? "ready" : { failed: "Could not browse this path." };

  const open = useCallback((item: FolderRowItem) => {
    if (!result) return;
    setPath(item.kind === "parent" ? item.path : joinPaths(result.path, item.name));
    setQuery("");
  }, [result]);

  return (
    <Picker
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search folders"
      items={items}
      total={null}
      status={status}
      onRetry={() => setAttempt((count) => count + 1)}
      renderItem={folderRow}
      onSelect={open}
      noMatchLabel={(needle) => `No folder matches “${needle}”.`}
      notice={result ? <span className="font-code text-fade">{result.path}</span> : undefined}
      footer={
        <Button type="button" size="compact" disabled={!result} onClick={() => result && onPick(result.path)} className="w-full">
          Use this folder
        </Button>
      }
    />
  );
}

interface FolderBrowseButtonProps {
  readonly startPath: string;
  readonly disabled: boolean;
  readonly onPick: (path: string) => void;
}

/**
 * "Browse…" beside the Location. Electron has a native folder dialog, so it opens that, as Add project does. A browser
 * has none, so it opens the server's folder browser in a popover over the dialog.
 */
export function FolderBrowseButton({ startPath, disabled, onPick }: FolderBrowseButtonProps) {
  const [open, setOpen] = useState(false);
  const bridge = window.desktopBridge;
  const face = (
    <>
      <FolderIcon aria-hidden data-icon="inline-start" />
      Browse…
    </>
  );
  if (bridge) {
    const chooseNatively = async () => {
      const path = await bridge.showOpenDialog({ title: "Choose where the project goes" });
      if (path) onPick(path);
    };
    return <Button type="button" variant="outline" disabled={disabled} onClick={() => void chooseNatively()}>{face}</Button>;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" disabled={disabled}>{face}</Button>} />
      <PopoverContent role="dialog" aria-label="Choose a folder" side="top" align="end" sideOffset={8} className={PICKER_PANEL_CLASS}>
        <FolderBrowser
          startPath={startPath.trim() || "~"}
          onPick={(path) => {
            onPick(path);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
