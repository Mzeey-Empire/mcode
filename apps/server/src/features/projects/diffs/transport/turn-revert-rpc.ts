import { WS_METHODS, type WsMethodName } from "@mcode/contracts";
import type { TurnRevertService } from "../revert/turn-revert-service.js";

type RevertMethod = "turn.revert.preview" | "turn.revert.apply" | "turn.revert.undo";
/** Identify the bounded revert RPC family. */
export function isTurnRevertRpcMethod(method: WsMethodName): method is RevertMethod {
  return method === "turn.revert.preview" || method === "turn.revert.apply" || method === "turn.revert.undo";
}
/** Validate untrusted RPC values before any repository or journal lookup. */
export function routeTurnRevertRpc(method: RevertMethod, params: unknown, deps: { turnRevertService: TurnRevertService }) {
  switch (method) {
    case "turn.revert.preview": return deps.turnRevertService.preview(WS_METHODS()[method].params.parse(params));
    case "turn.revert.apply": return deps.turnRevertService.apply(WS_METHODS()[method].params.parse(params));
    case "turn.revert.undo": return deps.turnRevertService.undo(WS_METHODS()[method].params.parse(params));
  }
}
