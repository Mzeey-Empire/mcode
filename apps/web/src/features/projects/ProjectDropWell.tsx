import { useState, type DragEvent } from "react";
import { FolderDown } from "lucide-react";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { cn } from "@/lib/utils";

type DropWellState = "idle" | "over";

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * Empty-workspace well under the Projects header. On desktop a folder dropped here
 * opens the add-project flow at that path; the palette decides whether it is addable.
 * The web build cannot read a dropped file's path, so it only points at the + button.
 */
export function ProjectDropWell() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  return bridge ? <DesktopDropWell getPathForFile={(file) => bridge.getPathForFile(file)} /> : <WellBody state="idle" caption="Use + to add a project." />;
}

function DesktopDropWell({ getPathForFile }: { getPathForFile: (file: File) => string }) {
  const [state, setState] = useState<DropWellState>("idle");

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setState("over");
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (isFileDrag(event)) setState("idle");
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setState("idle");
    const file = event.dataTransfer.files[0];
    const path = file ? getPathForFile(file) : "";
    if (path) useCommandPaletteStore.getState().open({ intent: "addProject", path });
  };

  return (
    <WellBody
      state={state}
      caption="Drop a folder here or use + to add one."
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    />
  );
}

interface WellBodyProps {
  state: DropWellState;
  caption: string;
  onDragEnter?: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}

function WellBody({ state, caption, ...dropHandlers }: WellBodyProps) {
  const over = state === "over";
  // Children ignore the pointer so drag enter and leave fire only for the well itself,
  // never when the pointer crosses the icon or text, which the over state also swaps out.
  return (
    <div
      data-testid="project-drop-well"
      data-state={state}
      className={cn(
        "flex h-full flex-col items-start justify-center gap-2 rounded-control border px-2 pb-11 transition-colors duration-(--duration-fast) *:pointer-events-none",
        over ? "border-control-border bg-hover" : "border-transparent",
      )}
      {...dropHandlers}
    >
      <FolderDown size={20} strokeWidth={1.5} aria-hidden className="text-muted" />
      {over ? (
        <p className="text-body-small font-medium text-ink">Drop to add project</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-body-small font-medium text-ink">No projects</p>
          <p className="text-caption text-muted">{caption}</p>
        </div>
      )}
    </div>
  );
}
