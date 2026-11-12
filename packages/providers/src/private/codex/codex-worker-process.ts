import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type { ProviderProcessOpener } from "../../host-ports.js";
import type { CodexAppServerProcessLauncher } from "./codex-app-server.js";

/** Keeps catalog process creation and termination off the server event loop. */
export function createWorkerCodexProcessLauncher(open: ProviderProcessOpener): CodexAppServerProcessLauncher {
  return (command, args, options) => {
    const events = new NodeEvents.EventEmitter();
    const metadata: { pid: number | undefined } = { pid: undefined };
    const stdout = new NodeStream.Readable({ read() {} });
    const stderr = new NodeStream.Readable({ read() {} });
    let session: ReturnType<ProviderProcessOpener>;
    const stdin = new NodeStream.Writable({
      write(chunk: Buffer, _encoding, callback) {
        session.write(chunk.toString("utf8"));
        callback();
      },
    });
    const child = Object.assign(events, metadata, {
      stdin, stdout, stderr,
      kill: (signal?: NodeJS.Signals) => { session.stop(signal === "SIGTERM"); return true; },
      terminate: async () => { session.stop(true); await session.exited; },
    });
    session = open({ command, args, ...options, timeout: 0 }, {
      onSpawn: (pid) => { child.pid = pid; events.emit("spawn"); },
      onStartError: (message) => queueMicrotask(() => events.emit("error", new Error(message))),
      onExit: (code, signal) => {
        stdout.push(null);
        stderr.push(null);
        events.emit("exit", code, signal);
      },
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
      onStdinError: (message) => stdin.destroy(new Error(message)),
    });
    return child;
  };
}
