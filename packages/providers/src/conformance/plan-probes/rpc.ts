import * as NodeReadline from "node:readline";
import type * as NodeChildProcess from "node:child_process";
import { z } from "zod";
import type { ProbeContext } from "./runtime.js";

const envelopeSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown(), result: z.unknown(), error: z.unknown() });
/** Shared line transport for the measured Codex and ACP protocols. */
export function openRpc(context: ProbeContext, child: NodeChildProcess.ChildProcessWithoutNullStreams) {
  let nextId = 0;
  const pending = new Map<string | number, { operation: string; resolve(value: unknown): void; reject(error: Error): void }>();
  const notifications: Array<{ method: string; params: unknown }> = [];
  const waiting: Array<{ method: string; resolve(value: unknown): void; reject(error: Error): void }> = [];
  let onRequest: (method: string, params: unknown, id: string | number) => Promise<void> = async (_method, _params, id) => { reply(id, { code: -32601, message: "Probe denied request" }, true); };
  let onEvent: (method: string, params: unknown) => void = () => undefined;
  function send(value: unknown): void { child.stdin.write(`${JSON.stringify(value)}\n`); }
  const incoming = new Map<string | number, string>();
  function reply(id: string | number, value: unknown, error = false): void {
    const operation = incoming.get(id);
    if (!operation) throw new Error("Reply has no incoming request");
    context.record({ kind: "reply", direction: "sent", operation, exchange: id, payload: error ? { error: value } : value });
    send(error ? { jsonrpc: "2.0", id, error: value } : { jsonrpc: "2.0", id, result: value });
    incoming.delete(id);
  }
  function receiveRequest(method: string, params: unknown, id: string | number): void {
    incoming.set(id, method);
    context.record({ kind: "request", direction: "received", operation: method, exchange: id, payload: params });
    void onRequest(method, params, id).catch(fail);
  }
  function receiveEvent(method: string, params: unknown): void {
    context.record({ kind: "event", direction: "received", operation: method, payload: params });
    onEvent(method, params);
    const index = waiting.findIndex((item) => item.method === method);
    if (index >= 0) waiting.splice(index, 1)[0]?.resolve(params);
    else notifications.push({ method, params });
  }
  function receiveReply(id: string | number, result: unknown, error: unknown): void {
    const request = pending.get(id);
    if (!request) throw new Error("Reply has no outgoing request");
    context.record({ kind: "reply", direction: "received", operation: request.operation, exchange: id, payload: error === undefined ? result : { error } });
    pending.delete(id);
    if (error !== undefined) request.reject(new Error(`RPC rejected ${request.operation}: ${JSON.stringify(error)}`));
    else request.resolve(result);
  }
  function receive(line: string): void {
    const message = envelopeSchema.parse(JSON.parse(line));
    if (message.method && message.id !== undefined) receiveRequest(message.method, message.params, message.id);
    else if (message.method) receiveEvent(message.method, message.params);
    else if (message.id !== undefined) receiveReply(message.id, message.result, message.error);
  }
  function fail(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  }
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => { try { receive(line); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); } });
  child.once("error", fail);
  child.once("exit", (code, signal) => { context.record({ kind: "event", direction: "received", operation: "probe/process-exit", payload: { code, signal } }); fail(new Error(`Provider exited ${code}`)); });
  return {
    child,
    reply,
    onRequest(handler: typeof onRequest) { onRequest = handler; },
    onEvent(handler: typeof onEvent) { onEvent = handler; },
    request(operation: string, params: unknown): Promise<unknown> {
      const id = ++nextId;
      context.record({ kind: "request", direction: "sent", operation, exchange: id, payload: params });
      const result = new Promise((resolve, reject) => pending.set(id, { operation, resolve, reject }));
      send({ jsonrpc: "2.0", id, method: operation, params });
      return result;
    },
    notify(operation: string, params: unknown) { context.record({ kind: "event", direction: "sent", operation, payload: params }); send({ jsonrpc: "2.0", method: operation, params }); },
    event(method: string): Promise<unknown> {
      const index = notifications.findIndex((item) => item.method === method);
      if (index >= 0) return Promise.resolve(notifications.splice(index, 1)[0]?.params);
      return new Promise((resolve, reject) => waiting.push({ method, resolve, reject }));
    },
  };
}
