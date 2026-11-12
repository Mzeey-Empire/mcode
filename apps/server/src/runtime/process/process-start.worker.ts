import { describeProcessStartFailure, runProcessStart, openProcessStart, type ProcessStartSession, type ProcessOutputObserver } from "./process-start.js";
import type { ProcessStartObservedStreams, ProcessStartWorkerInbound, ProcessStartWorkerOutbound } from "./process-start-worker-client.js";

function post(message: ProcessStartWorkerOutbound): void {
  globalThis.postMessage(message);
}

function forwardOutput(id: number, observe: ProcessStartObservedStreams): ProcessOutputObserver {
  return {
    ...(observe.stdout ? { onStdout: (chunk: string) => post({ id, output: "stdout", chunk }) } : {}),
    ...(observe.stderr ? { onStderr: (chunk: string) => post({ id, output: "stderr", chunk }) } : {}),
    ...(observe.stdinError ? { onStdinError: (message: string) => post({ id, stdinError: message }) } : {}),
  };
}

const sessions = new Map<number, ProcessStartSession>();

globalThis.onmessage = (event: MessageEvent<ProcessStartWorkerInbound>): void => {
  const message = event.data;
  const { id } = message;
  if (message.kind === "write") {
    sessions.get(id)?.write(message.text);
    return;
  }
  if (message.kind === "stop") {
    sessions.get(id)?.stop();
    return;
  }
  const { request, observe } = message;
  if (message.kind === "open") {
    const session = openProcessStart(request, observe ? forwardOutput(id, observe) : {});
    sessions.set(id, session);
    void session.exited.then(() => {
      sessions.delete(id);
      post({ id, exited: true });
    });
    return;
  }
  runProcessStart(request, observe ? forwardOutput(id, observe) : undefined).then(
    (result) => post({ id, ok: true, result }),
    (error: unknown) => post({ id, ok: false, failure: describeProcessStartFailure(error) }),
  );
};
