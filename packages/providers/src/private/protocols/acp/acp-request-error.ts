/**
 * @internal
 * Reads the JSON-RPC error an ACP agent returned for a failed request.
 */

import { RequestError } from "@agentclientprotocol/sdk";

/** ACP JSON-RPC code for "Authentication required". */
export const ACP_AUTH_REQUIRED_CODE = -32000;

const MAX_ERROR_DETAIL_CHARS = 2_000;

/** Returns the JSON-RPC code of an ACP request rejection, if the error is one. */
export function acpRequestErrorCode(error: unknown): number | undefined {
  return error instanceof RequestError ? error.code : undefined;
}

/**
 * Describes an ACP failure including the agent's `data`. When an agent handler
 * throws a plain Error, the SDK replies "Internal error" and moves the real
 * cause (for example a 429) into `data.details`, so the message alone hides it.
 */
export function describeAcpError(error: unknown): string {
  if (error instanceof RequestError) {
    const detail = requestErrorDetail(error.data);
    if (!detail || detail === error.message) return error.message;
    return `${error.message}: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function requestErrorDetail(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data === null || typeof data !== "object") return undefined;
  for (const key of ["details", "message"]) {
    const detail: unknown = Reflect.get(data, key);
    if (typeof detail === "string") return detail;
  }
  if (Object.keys(data).length === 0) return undefined;
  return JSON.stringify(data);
}
