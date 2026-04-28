import { useState, useEffect, useCallback } from "react";
import { CommandGroup, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getTransport } from "@/transport";
import { Kbd } from "../Kbd";

/** Props for AddProjectView. */
interface Props {
  /** Current directory being browsed. */
  path: string;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; isDir: boolean }[];
}

/**
 * Palette subview for adding a new project via inline folder-browse-as-search.
 * Powered by the filesystem.browse RPC — no native OS dialog required.
 * Pressing Cmd/Ctrl+Enter at any path creates the workspace.
 */
export function AddProjectView({ path }: Props) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const { close, push, setPendingConfirm } = useCommandPaletteStore();
  const { createWorkspace, setActiveWorkspace } = useWorkspaceStore();

  const browse = useCallback(async (target: string) => {
    setLoading(true);
    try {
      const data = await getTransport().filesystemBrowse(target);
      setResult(data);
    } catch {
      // stay on current result on error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    browse(path);
  }, [path, browse]);

  const navigateTo = (newPath: string) => {
    push({ kind: "addProject", path: newPath });
  };

  const handleAdd = useCallback(async () => {
    const target = result?.path ?? path;
    const name = target.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Untitled";
    try {
      const ws = await createWorkspace(name, target);
      setActiveWorkspace(ws.id);
      close();
    } catch (err) {
      console.error("Failed to create workspace:", err);
    }
  }, [result, path, createWorkspace, setActiveWorkspace, close]);

  // Register handleAdd as the Ctrl+Enter confirm action while this view is mounted.
  // Re-register whenever result changes so the closure captures the latest path.
  useEffect(() => {
    setPendingConfirm(() => handleAdd);
    return () => setPendingConfirm(null);
  }, [handleAdd, setPendingConfirm]);

  const currentPath = result?.path ?? path;
  const segments = currentPath.replace(/\\/g, "/").split("/").filter(Boolean);

  return (
    <>
      {/* Breadcrumb header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[11.5px] text-muted-foreground/70 overflow-x-auto">
          {result?.parent && (
            <button
              className="shrink-0 hover:text-foreground"
              onClick={() => result.parent && navigateTo(result.parent)}
            >
              ..
            </button>
          )}
          {segments.map((seg, i) => (
            <span key={i} className="shrink-0">
              {i > 0 && <span className="mx-0.5 opacity-40">/</span>}
              {seg}
            </span>
          ))}
        </div>
        <button
          data-testid="add-project-add"
          className="ml-3 shrink-0 rounded-sm bg-primary/90 px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-primary-foreground hover:bg-primary"
          onClick={handleAdd}
          title="Add this folder as a project (Ctrl+Enter)"
        >
          Add <Kbd>↵</Kbd>
        </button>
      </div>

      <CommandList className="max-h-72 overflow-y-auto">
        {loading && <CommandEmpty>Loading…</CommandEmpty>}
        {!loading && (!result || result.entries.length === 0) && (
          <CommandEmpty>Empty directory.</CommandEmpty>
        )}
        {!loading && result && result.entries.length > 0 && (
          <CommandGroup>
            {result.entries.map((entry) => (
              <CommandItem
                key={entry.name}
                value={entry.name}
                className="flex items-center gap-2 px-3 py-2 font-mono text-[12.5px]"
                onSelect={() => {
                  if (entry.isDir) {
                    const next = currentPath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + entry.name;
                    navigateTo(next);
                  }
                }}
              >
                <span className="shrink-0 text-muted-foreground/50">
                  {entry.isDir ? "▸" : "·"}
                </span>
                <span className={entry.isDir ? "text-foreground" : "text-muted-foreground/70"}>
                  {entry.name}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      {/* Footer hint */}
      <div className="flex items-center justify-between border-t border-border/50 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/30">
          <Kbd>↵</Kbd> Navigate  ·  <Kbd>⌫</Kbd> Back
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/30">
          <Kbd>Ctrl ↵</Kbd> Add project
        </span>
      </div>
    </>
  );
}
