/**
 * Pure omnibox target normalization and validation for Preview navigation.
 */

import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";

import {
  looksLikeFilePath,
  resolveLocalFileUrl,
  resolveMcodeWorkspacePreviewUrl,
} from "./local-file.js";

/** Result returned after normalizing and validating an omnibox target. */
export type PreviewResolveNavigationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Validates a complete Preview address before it is stored on a tab or loaded
 * into a Browser surface.
 */
export async function validatePreviewNavigationUrl(
  url: string,
): Promise<PreviewResolveNavigationResult> {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: "empty-url" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid-url" };
  }

  if (parsed.protocol === "file:") return resolveLocalFileUrl(trimmed, null);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "invalid-url" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: "invalid-url" };
  }
  return { ok: true, url: trimmed };
}

/**
 * Returns true when `input` looks like a bare host rather than a free-form search query.
 */
export function looksLikeBareDomain(input: string): boolean {
  if (/\s/.test(input)) return false;
  const hostPart = input.split("/", 1)[0]!;
  if (hostPart.length === 0) return false;
  if (/^\[[0-9a-f:.]+\](:\d+)?$/i.test(hostPart)) return true;
  if (!/^[a-z0-9.\-:]+$/i.test(hostPart)) return false;
  if (hostPart === "localhost" || /^localhost:\d+$/.test(hostPart)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart)) return true;
  if (!hostPart.includes(".")) return false;
  const tld = hostPart.split(":")[0]!.split(".").pop() ?? "";
  return /^[a-z][a-z0-9-]{1,}$/i.test(tld);
}

/**
 * Picks the scheme for a bare omnibox address: http for loopback and IP literals,
 * which local dev servers serve without TLS, https otherwise.
 */
function bareAddressScheme(input: string): "http" | "https" {
  const hostPart = input.split("/", 1)[0]!;
  if (hostPart.startsWith("[")) return "http";
  const hostname = hostPart.split(":", 1)[0]!.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "http";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return "http";
  return "https";
}

/** Resolve user omnibox input to a safe Preview URL without loading it. */
export async function resolvePreviewNavigationTarget(
  url: string,
  workspacePath?: string | null,
): Promise<PreviewResolveNavigationResult> {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: "empty-url" };
  return resolvePreviewTarget(trimmed, workspacePath?.trim() ?? null);
}

async function resolvePreviewTarget(
  trimmed: string,
  workspacePath: string | null,
): Promise<PreviewResolveNavigationResult> {
  if (isMcodeWorkspacePreviewUrl(trimmed)) {
    return resolveMcodeWorkspacePreviewUrl(trimmed, workspacePath);
  }
  if (/^https?:\/\//i.test(trimmed)) return validatePreviewNavigationUrl(trimmed);
  if (/^file:\/\//i.test(trimmed) || looksLikeFilePath(trimmed)) {
    return resolveLocalFileUrl(trimmed, workspacePath);
  }
  if (looksLikeBareDomain(trimmed)) return validatePreviewNavigationUrl(`${bareAddressScheme(trimmed)}://${trimmed}`);
  return validatePreviewNavigationUrl(`https://www.google.com/search?q=${encodeURIComponent(trimmed)}`);
}
