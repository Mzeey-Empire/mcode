import { useState, type ReactNode } from "react";
import { FolderOpen, RotateCcw } from "lucide-react";
import type { ProjectIcon as ProjectIconModel } from "@mcode/contracts";
import { IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FILE_EXPLORER_ID } from "@/lib/resolveDefaultOpenInApp";
import { ProjectIcon } from "@/features/projects/icons/ProjectIcon";
import { ProjectIconPicker } from "@/features/projects/icons/ProjectIconPicker";
import { useProjectIconStore } from "@/features/projects/icons/projectIconStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function reportFailure(title: string, error: unknown): void {
  useToastStore.getState().show({ kind: "failed", title, meta: error instanceof Error ? error.message : String(error) });
}

function SettingRow({ title, last = false, detail, children }: {
  readonly title: string;
  readonly last?: boolean;
  readonly detail: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-3.5 py-3.5", !last && "border-b border-border")}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body-small text-ink">{title}</span>
        <span className="text-fade text-caption text-muted">{detail}</span>
      </div>
      {children}
    </div>
  );
}

function Mono({ children }: { readonly children: string }) {
  return <span className="font-mono">{children}</span>;
}

function iconSource(icon: ProjectIconModel | undefined, chosenPath: string | null): ReactNode {
  if (!icon) return "Automatic";
  if (icon.source === "chosen") return <Mono>{icon.path}</Mono>;
  if (icon.chosenMissing && chosenPath) return <><Mono>{chosenPath}</Mono> is missing · using automatic</>;
  return icon.source === "automatic" ? <>Automatic · <Mono>{icon.path}</Mono></> : "Automatic · no icon file found";
}

function NameField({ workspaceId, name, defaultName }: { readonly workspaceId: string; readonly name: string; readonly defaultName: string }) {
  const [draft, setDraft] = useState(name);
  const renameWorkspace = useWorkspaceStore((state) => state.renameWorkspace);

  const commit = () => {
    const next = draft.trim() || defaultName;
    setDraft(next);
    if (next === name) return;
    renameWorkspace(workspaceId, next).catch((error: unknown) => {
      setDraft(name);
      reportFailure("Project could not be renamed", error);
    });
  };

  return (
    <Input
      size="compact"
      aria-label="Name"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(name);
      }}
      className="w-[200px] shrink-0"
    />
  );
}

/**
 * The General section of Project settings. Unlike Actions it has no draft: each control
 * applies as soon as it changes.
 */
export function GeneralSection({ workspaceId }: { readonly workspaceId: string }) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === workspaceId));
  const icon = useProjectIconStore((state) => state.iconsByWorkspaceId[workspaceId]);
  if (!workspace) return null;

  const hasChoice = icon?.source === "chosen" || icon?.chosenMissing === true;
  const chosenPath = icon?.source === "chosen" ? icon.path : workspace.icon_path;

  const saveIcon = (iconPath: string | null) => {
    getTransport().setProjectIcon(workspaceId, iconPath).then(
      (saved) => {
        useProjectIconStore.getState().applyIcon(saved);
        useWorkspaceStore.getState().applyWorkspaceIconPath(workspaceId, iconPath);
      },
      (error: unknown) => reportFailure("Icon could not be saved", error),
    );
  };

  return (
    <div className="flex flex-col px-2">
      <SettingRow title="Icon" detail={iconSource(icon, chosenPath)}>
        <ProjectIcon workspaceId={workspaceId} name={workspace.name} size={40} />
        <ProjectIconPicker workspaceId={workspaceId} chosenPath={icon?.source === "chosen" ? icon.path : null} onPick={saveIcon} />
        {hasChoice ? (
          <IconButton shape="round" aria-label="Use automatic" tooltip="Use automatic" onClick={() => saveIcon(null)}>
            <RotateCcw />
          </IconButton>
        ) : null}
      </SettingRow>
      <SettingRow title="Name" detail="Defaults to the folder name">
        <NameField key={workspace.name} workspaceId={workspaceId} name={workspace.name} defaultName={folderName(workspace.path)} />
      </SettingRow>
      <SettingRow title="Location" last detail={<Mono>{workspace.path}</Mono>}>
        <IconButton
          shape="round"
          aria-label="Open folder"
          onClick={() => {
            getTransport().openIn(FILE_EXPLORER_ID, workspace.path).catch((error: unknown) => reportFailure("Couldn't open File Explorer", error));
          }}
        >
          <FolderOpen />
        </IconButton>
      </SettingRow>
    </div>
  );
}
