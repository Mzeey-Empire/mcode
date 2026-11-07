import { describeGitProcessFailure, runGitProcess, type GitOutputObserver } from "./git-process.js";
import type { GitProcessObservedStreams, GitProcessWorkerInbound, GitProcessWorkerOutbound } from "./git-process-worker-client.js";

function post(message: GitProcessWorkerOutbound): void {
  globalThis.postMessage(message);
}

function forwardOutput(id: number, observe: GitProcessObservedStreams): GitOutputObserver {
  return {
    ...(observe.stdout ? { onStdout: (chunk: string) => post({ id, output: "stdout", chunk }) } : {}),
    ...(observe.stderr ? { onStderr: (chunk: string) => post({ id, output: "stderr", chunk }) } : {}),
  };
}

globalThis.onmessage = (event: MessageEvent<GitProcessWorkerInbound>): void => {
  const { id, request, observe } = event.data;
  runGitProcess(request, observe ? forwardOutput(id, observe) : undefined).then(
    (result) => post({ id, ok: true, result }),
    (error: unknown) => post({ id, ok: false, failure: describeGitProcessFailure(error) }),
  );
};
