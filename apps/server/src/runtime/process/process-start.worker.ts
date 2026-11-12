import { describeProcessStartFailure, runProcessStart, type ProcessOutputObserver } from "./process-start.js";
import type { ProcessStartObservedStreams, ProcessStartWorkerInbound, ProcessStartWorkerOutbound } from "./process-start-worker-client.js";

function post(message: ProcessStartWorkerOutbound): void {
  globalThis.postMessage(message);
}

function forwardOutput(id: number, observe: ProcessStartObservedStreams): ProcessOutputObserver {
  return {
    ...(observe.stdout ? { onStdout: (chunk: string) => post({ id, output: "stdout", chunk }) } : {}),
    ...(observe.stderr ? { onStderr: (chunk: string) => post({ id, output: "stderr", chunk }) } : {}),
  };
}

globalThis.onmessage = (event: MessageEvent<ProcessStartWorkerInbound>): void => {
  const { id, request, observe } = event.data;
  runProcessStart(request, observe ? forwardOutput(id, observe) : undefined).then(
    (result) => post({ id, ok: true, result }),
    (error: unknown) => post({ id, ok: false, failure: describeProcessStartFailure(error) }),
  );
};
