/**
 * @internal
 * Resolves the headless `windsurf-api-key` credentials Devin's ACP host
 * requires. The `devin acp` process does not reliably consume the local CLI
 * credential store or environment on its own, so the adapter forwards an
 * explicit `_meta.api_key` after `initialize`.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { parse as parseToml } from "smol-toml";

/** Resolved Devin ACP authentication material. */
export interface DevinAcpCredentials {
  apiKey: string;
  apiServerUrl?: string;
}

const API_KEY_ENV_NAMES = ["WINDSURF_API_KEY", "DEVIN_API_KEY", "windsurf_api_key"] as const;

const MISSING_CREDENTIALS_MESSAGE =
  "Devin credentials not found. Run `devin auth login` or set WINDSURF_API_KEY.";

/** Resolves the Devin API key and optional API server URL for ACP authentication. */
export function resolveDevinAcpCredentials(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): DevinAcpCredentials {
  for (const name of API_KEY_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) return { apiKey: value, apiServerUrl: validatedApiServerUrl(env) };
  }
  const fromFile = readDevinCredentialsFile(platform);
  if (fromFile) return fromFile;
  throw new Error(MISSING_CREDENTIALS_MESSAGE);
}

function credentialsFileCandidates(platform: NodeJS.Platform): string[] {
  const home = NodeOS.homedir();
  if (platform === "win32") {
    const appData = process.env.APPDATA;
    return [
      ...(appData ? [NodePath.join(appData, "devin", "credentials.toml")] : []),
      NodePath.join(home, "AppData", "Roaming", "devin", "credentials.toml"),
    ];
  }
  const xdgData = process.env.XDG_DATA_HOME;
  return [
    ...(xdgData ? [NodePath.join(xdgData, "devin", "credentials.toml")] : []),
    NodePath.join(home, ".local", "share", "devin", "credentials.toml"),
  ];
}

function readDevinCredentialsFile(platform: NodeJS.Platform): DevinAcpCredentials | undefined {
  for (const filePath of credentialsFileCandidates(platform)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(NodeFS.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const apiKey = findStringField(parsed, "windsurf_api_key");
    if (!apiKey) continue;
    const apiServerUrl = validateApiServerUrl(findStringField(parsed, "api_server_url"));
    return apiServerUrl ? { apiKey, apiServerUrl } : { apiKey };
  }
  return undefined;
}

/** Searches top-level keys then one level of tables for a string field. */
function findStringField(root: Record<string, unknown>, key: string): string | undefined {
  const direct = root[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const value of Object.values(root)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = (value as Record<string, unknown>)[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return undefined;
}

function validatedApiServerUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return validateApiServerUrl(
    env.DEVIN_API_SERVER_URL ?? env.WINDSURF_API_SERVER_URL ?? env.api_server_url,
  );
}

/**
 * Accepts HTTPS URLs, plus loopback HTTP for local development. Rejects URLs
 * with embedded credentials so a key never travels inside a URL.
 */
export function validateApiServerUrl(value: unknown): string | undefined {
  const url = parseUrl(value);
  if (!url || url.username || url.password) return undefined;
  if (url.protocol === "https:") return url.toString();
  return isLoopbackHttp(url) ? url.toString() : undefined;
}

function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host.endsWith(".localhost");
}
