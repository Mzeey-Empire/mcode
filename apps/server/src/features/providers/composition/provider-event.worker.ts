import {
  processProviderEventWorkerTask,
  type ProviderEventWorkerRequest,
  type ProviderEventWorkerResponse,
} from "./provider-event-worker-protocol.js";

globalThis.onmessage = (message: MessageEvent<ProviderEventWorkerRequest>): void => {
  const response: ProviderEventWorkerResponse = {
    requestIds: message.data.requestIds,
    outcomes: message.data.tasks.map(processProviderEventWorkerTask),
  };
  globalThis.postMessage(response);
};
