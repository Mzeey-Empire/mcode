import { describeGitProcessFailure, runGitProcess } from "./git-process.js";
import type { GitProcessWorkerInbound, GitProcessWorkerOutbound } from "./git-process-worker-client.js";

function post(message: GitProcessWorkerOutbound): void {
  globalThis.postMessage(message);
}

globalThis.onmessage = (event: MessageEvent<GitProcessWorkerInbound>): void => {
  const { id, request } = event.data;
  runGitProcess(request).then(
    (result) => post({ id, ok: true, result }),
    (error: unknown) => post({ id, ok: false, failure: describeGitProcessFailure(error) }),
  );
};
