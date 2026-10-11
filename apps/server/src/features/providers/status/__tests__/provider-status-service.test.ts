import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentEventType,
  SettingsSchema,
  type ProviderId,
  type ProviderStatusFacts,
  type Settings,
} from "@mcode/contracts";
import { describeDevinAuth } from "@mcode/providers";
import { ProviderRateLimitStore } from "../provider-rate-limit-store.js";
import { ProviderStatusService, type StatusSourceRegistry } from "../provider-status-service.js";

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock("../../../../application/transport/push.js", () => ({ broadcast: broadcastMock }));

const SIGNED_IN: ProviderStatusFacts = { auth: { state: "signed_in" } };

function makeSettings(enabled: Partial<Settings["provider"]["enabled"]>): Settings {
  const settings = SettingsSchema().parse({});
  settings.provider.enabled = { ...settings.provider.enabled, ...enabled };
  return settings;
}

function makeService(
  enabled: Partial<Settings["provider"]["enabled"]>,
  sources: Array<{ id: ProviderId; describeStatus?: () => Promise<ProviderStatusFacts> }>,
  rateLimits = new ProviderRateLimitStore(),
): ProviderStatusService {
  const settings = makeSettings(enabled);
  const registry: StatusSourceRegistry = { resolveAll: () => sources };
  return new ProviderStatusService({ get: () => settings }, registry, rateLimits);
}

function pushedStatuses(): unknown[] {
  return broadcastMock.mock.calls.map(([channel, status]) => {
    expect(channel).toBe("providers.statusChanged");
    return status;
  });
}

beforeEach(() => {
  broadcastMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProviderStatusService with the real Devin check", () => {
  let home: string;

  beforeEach(async () => {
    home = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-status-"));
  });

  afterEach(async () => {
    await NodeFSPromises.rm(home, { recursive: true, force: true });
  });

  function devinWith(extraEnv: Record<string, string>) {
    const env = { HOME: home, USERPROFILE: home, APPDATA: home, XDG_DATA_HOME: home, ...extraEnv };
    return { id: "devin" as const, describeStatus: async () => describeDevinAuth(env, process.platform) };
  }

  it("reports signed out with the login command when no credentials exist", async () => {
    const statuses = await makeService({ devin: true }, [devinWith({})]).listStatus();
    expect(statuses).toEqual([
      expect.objectContaining({
        providerId: "devin",
        auth: { state: "signed_out", signIn: { kind: "terminal", argv: ["devin", "auth", "login"] } },
        rateLimit: null,
      }),
    ]);
  });

  it("reports signed in when an API key is set", async () => {
    const statuses = await makeService({ devin: true }, [devinWith({ DEVIN_API_KEY: "placeholder" })]).listStatus();
    expect(statuses[0]?.auth).toEqual({ state: "signed_in" });
  });
});

describe("ProviderStatusService refresh", () => {
  it("keeps the last known auth for a provider whose check throws while others update", async () => {
    let claudeFacts: ProviderStatusFacts = SIGNED_IN;
    let codexFails = false;
    const service = makeService({ claude: true, codex: true, cursor: false }, [
      { id: "claude", describeStatus: async () => claudeFacts },
      {
        id: "codex",
        describeStatus: async () => {
          if (codexFails) throw new Error("boom");
          return SIGNED_IN;
        },
      },
      { id: "cursor", describeStatus: async () => SIGNED_IN },
    ]);

    await service.refresh();
    claudeFacts = { auth: { state: "signed_out", signIn: { kind: "terminal", argv: ["claude"] } } };
    codexFails = true;
    broadcastMock.mockReset();
    const statuses = await service.listStatus({ force: true });

    expect(statuses.map((status) => [status.providerId, status.auth.state])).toEqual([
      ["claude", "signed_out"],
      ["codex", "signed_in"],
    ]);
    expect(pushedStatuses()).toEqual([expect.objectContaining({ providerId: "claude" })]);
  });

  it("reports unknown for a provider without a check or whose first check throws", async () => {
    const statuses = await makeService({ claude: true, codex: true }, [
      { id: "claude" },
      { id: "codex", describeStatus: async () => { throw new Error("boom"); } },
    ]).listStatus();
    expect(statuses.map((status) => status.auth)).toEqual([{ state: "unknown" }, { state: "unknown" }]);
  });

  it("serves the cache for 10 minutes unless forced", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T12:00:00Z") });
    const describeStatus = vi.fn(async () => SIGNED_IN);
    const service = makeService({ claude: true }, [{ id: "claude", describeStatus }]);

    await service.listStatus();
    vi.advanceTimersByTime(9 * 60 * 1000);
    await service.listStatus();
    expect(describeStatus).toHaveBeenCalledTimes(1);

    await service.listStatus({ force: true });
    expect(describeStatus).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10 * 60 * 1000);
    await service.listStatus();
    expect(describeStatus).toHaveBeenCalledTimes(3);
  });
});

describe("ProviderStatusService rate limits", () => {
  it("pushes a limit when it starts, when it lifts, and when its reset time passes", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T12:00:00Z") });
    const rateLimits = new ProviderRateLimitStore();
    const service = makeService({ claude: true }, [{ id: "claude", describeStatus: async () => SIGNED_IN }], rateLimits);
    await service.refresh();
    broadcastMock.mockReset();

    const limited = { type: AgentEventType.RateLimited, threadId: "t1", active: true, limitType: "five_hour" };
    rateLimits.record("claude", { ...limited, retryAfterMs: 60_000 });
    rateLimits.record("claude", { ...limited, active: false });
    rateLimits.record("claude", { ...limited, retryAfterMs: 30_000 });
    vi.advanceTimersByTime(30_000);

    expect(pushedStatuses()).toEqual([
      expect.objectContaining({ rateLimit: { resetsAt: "2026-01-01T12:01:00.000Z", limitType: "five_hour" } }),
      expect.objectContaining({ rateLimit: null }),
      expect.objectContaining({ rateLimit: { resetsAt: "2026-01-01T12:00:30.000Z", limitType: "five_hour" } }),
      expect.objectContaining({ rateLimit: null }),
    ]);
    expect((await service.listStatus())[0]?.auth).toEqual({ state: "signed_in" });
  });

  it("ignores limits for a disabled provider", () => {
    const rateLimits = new ProviderRateLimitStore();
    makeService({ claude: false }, [], rateLimits);
    rateLimits.record("claude", { active: true, retryAfterMs: 60_000 });
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
