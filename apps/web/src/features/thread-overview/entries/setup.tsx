import { ProjectSetupAttemptCard } from "@/features/projects/environment";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";

function SetupEntry() {
  const { projectSetup } = useOverviewContext();
  if (!projectSetup.startError && !projectSetup.attempt) return null;

  return (<>
    {projectSetup.startError ? <p role="alert" className="mx-1.5 mt-1.5 text-xs text-destructive">{projectSetup.startError}</p> : null}
    {projectSetup.attempt ? <ProjectSetupAttemptCard attempt={projectSetup.attempt} onApprove={projectSetup.approve} /> : null}
  </>);
}

/** Setup block in the thread overview, preserving its existing row position. */
export function SetupEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <SetupEntry /> : null;
}
