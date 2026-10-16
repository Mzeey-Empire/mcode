import * as NodeNet from "node:net";
import type { ActionPortCandidate } from "./action-port-detector.js";

/** Checks TCP acceptance on the printed loopback address, without claiming app health. */
export async function probeActionPort(candidate: ActionPortCandidate): Promise<boolean> {
  if (candidate.host === "localhost") {
    return connectLocalhost(candidate.port);
  }
  const host = candidate.host === "::" || candidate.host === "::1" ? "::1" : "127.0.0.1";
  return connect(host, candidate.port);
}

function connectLocalhost(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let failures = 0;
    for (const host of ["::1", "127.0.0.1"]) {
      void connect(host, port).then((reachable) => {
        if (reachable) resolve(true);
        else if (++failures === 2) resolve(false);
      });
    }
  });
}

function connect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection({ host, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
