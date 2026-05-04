import type { EnvService } from "../services/env-service.js";
import { flattenProcessEnv } from "../services/shell-env-utils.js";

/**
 * Minimal `EnvService` for unit tests that construct providers without the DI container.
 */
export function stubEnvService(): EnvService {
  return {
    getEnv: () => ({ ...flattenProcessEnv(process.env) }),
  } as EnvService;
}
