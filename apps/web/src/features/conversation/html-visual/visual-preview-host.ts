import {
  VisualPreviewRequestSchema,
  type VisualPreviewOutcome,
  type VisualPreviewRequest,
} from "@mcode/contracts/ws/visual-preview";
import { useConnectionStore } from "@/stores/connectionStore";
import { getTransport, pushEmitter } from "@/transport";

type RenderPreview = (request: VisualPreviewRequest) => Promise<VisualPreviewOutcome>;

async function renderPreview(render: RenderPreview, request: VisualPreviewRequest): Promise<VisualPreviewOutcome> {
  try {
    return await render(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: "error", message: message.slice(0, 2000) };
  }
}

/** Relays directed preview requests to desktop main for the lifetime of this renderer. */
export function startVisualPreviewHost(): (() => void) | undefined {
  const render = window.desktopBridge?.renderVisualPreview;
  if (!render) return;

  const transport = getTransport();
  let stopListening: (() => void) | undefined;

  const listen = () => {
    let connected = true;
    const unsubscribe = pushEmitter.on("visualPreview.request", (data) => {
      const request = VisualPreviewRequestSchema().safeParse(data);
      if (!request.success) return;
      const { requestId } = request.data;
      void renderPreview(render, request.data).then(async (outcome) => {
        if (connected) await transport.respondToVisualPreview({ requestId, outcome });
      }).catch(() => {
        // The server settles renders when their connection closes.
      });
    });
    stopListening = () => {
      connected = false;
      unsubscribe();
    };
    void transport.registerVisualPreviewHost().catch(() => {
      // Registration is retried on the next connection.
    });
  };

  const unsubscribeConnection = useConnectionStore.subscribe((state, previous) => {
    if (state.status === previous.status) return;
    stopListening?.();
    stopListening = undefined;
    if (state.status === "connected") listen();
  });
  if (useConnectionStore.getState().status === "connected") listen();

  return () => {
    stopListening?.();
    unsubscribeConnection();
  };
}
