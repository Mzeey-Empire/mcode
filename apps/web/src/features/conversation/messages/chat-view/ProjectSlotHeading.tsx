import { ProjectChooser } from "@/features/projects/ProjectChooser";
import { cn } from "@/lib/utils";

/** Props for {@link ProjectSlotHeading}. */
export interface ProjectSlotHeadingProps {
  /** Active project name, or undefined before a project is chosen. */
  readonly projectName: string | undefined;
}

/** The new-thread question whose project name is a slot that opens the project chooser. */
export function ProjectSlotHeading({ projectName }: ProjectSlotHeadingProps) {
  return (
    // The slot group starts from a zero basis so a long name fades inside the slot on wide rails, and only
    // drops to its own line once the prefix leaves it less than its minimum, which keeps the chooser reachable.
    <h1
      aria-label={projectName ? `What should we build in ${projectName}?` : "What should we build in a project?"}
      className="flex min-w-0 max-w-full flex-wrap items-start justify-center text-3xl font-semibold tracking-[-0.02em] text-ink"
    >
      <span>What should we build in&nbsp;</span>
      <span className="flex min-w-[12rem] max-w-fit flex-[1_1_0] whitespace-nowrap">
        <ProjectChooser
          triggerTooltip={projectName ? "Change project" : "Choose project"}
          trigger={
            <button
              type="button"
              data-testid="new-thread-project-slot"
              className={cn(
                "flex min-w-0 border-b-2 border-dashed border-primary pb-0.5 text-primary transition-colors hover:border-primary/60 hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                !projectName && "px-1",
              )}
            >
              {/* The fade masks only the name; masking the button would clip its focus outline. */}
              <span className="text-fade">{projectName ?? "choose a project"}</span>
            </button>
          }
        />
        <span className={cn("shrink-0", !projectName && "pl-0.5")}>?</span>
      </span>
    </h1>
  );
}
