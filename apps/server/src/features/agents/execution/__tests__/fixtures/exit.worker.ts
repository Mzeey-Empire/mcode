globalThis.onmessage = (): void => globalThis.close();
globalThis.postMessage({ kind: "ready" });
