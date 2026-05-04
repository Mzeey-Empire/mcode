import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EnvService } from "../env-service.js";
import type { ProtectedEnvStore } from "../protected-env-store.js";
import type { ShellEnvResolver } from "../shell-env-resolver.js";

function makeResolver(
  envMap: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/user" },
): ShellEnvResolver {
  return { resolveFresh: vi.fn(() => ({ ...envMap })) } as unknown as ShellEnvResolver;
}

function makeStore(
  snapshot: Record<string, string> = { MCODE_PORT: "19400" },
): ProtectedEnvStore {
  return {
    applyTo: vi.fn((resolved: Record<string, string>) => ({
      ...resolved,
      ...snapshot,
    })),
  } as unknown as ProtectedEnvStore;
}

describe("EnvService", () => {
  let resolver: ShellEnvResolver;
  let store: ProtectedEnvStore;
  let service: EnvService;

  beforeEach(() => {
    resolver = makeResolver();
    store = makeStore();
    service = new EnvService(resolver, store);
  });

  it("returns merged env with protected keys winning", () => {
    const env = service.getEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.MCODE_PORT).toBe("19400");
  });

  it("calls resolveFresh on first access", () => {
    service.getEnv();
    expect(resolver.resolveFresh).toHaveBeenCalledOnce();
  });

  it("returns cached result within TTL window", () => {
    service.getEnv();
    service.getEnv();
    service.getEnv();
    // Only one resolution despite three calls.
    expect(resolver.resolveFresh).toHaveBeenCalledOnce();
  });

  it("re-resolves after TTL expires", () => {
    vi.useFakeTimers();
    try {
      service.getEnv();
      expect(resolver.resolveFresh).toHaveBeenCalledOnce();

      // Advance past the 60s TTL.
      vi.advanceTimersByTime(61_000);
      service.getEnv();
      expect(resolver.resolveFresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a defensive copy (mutations do not leak back)", () => {
    const first = service.getEnv();
    first.PATH = "/hacked";
    const second = service.getEnv();
    expect(second.PATH).toBe("/usr/bin");
  });

  it("includes current process.env as base layer", () => {
    const prev = process.env.SOME_RANDOM_VAR;
    process.env.SOME_RANDOM_VAR = "from-process";
    try {
      const env = service.getEnv();
      // process.env values appear in the base, but shell resolution values
      // override them when both define the same key.
      expect(env.SOME_RANDOM_VAR).toBe("from-process");
    } finally {
      if (prev === undefined) delete process.env.SOME_RANDOM_VAR;
      else process.env.SOME_RANDOM_VAR = prev;
    }
  });

  it("protected keys override shell-resolved values", () => {
    const resolverWithConflict = makeResolver({ MCODE_PORT: "from-shell" });
    const storeWithMcode = makeStore({ MCODE_PORT: "19400" });
    const svc = new EnvService(resolverWithConflict, storeWithMcode);

    const env = svc.getEnv();
    expect(env.MCODE_PORT).toBe("19400");
  });
});
