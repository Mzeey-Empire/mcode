import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import { notifyCommittedCanonicalEvents } from "../../canonical/committed-canonical-events.js";
import { ProviderSwitchService, type PlannedSwitch, type ProviderSwitchTicket } from "../provider-switch-service.js";
import type { SendMessageCommand } from "../turn-admission-dispatch-coordinator.js";

const THREAD_ID = "thread-1";

function event(turnId: string, type: string): CanonicalAgentEventEnvelope {
  return { routing: { turnId }, payload: { type } } as unknown as CanonicalAgentEventEnvelope;
}

function plannedSwitch(): PlannedSwitch {
  return {
    handoff: {
      mode: "fresh",
      preamble: "",
      selection: { text: "", selectedSequences: [], omittedSequences: [], budgetBytes: 0 },
      coverage: { threadId: THREAD_ID, kind: "switch", fromProvider: "claude", toProvider: "codex", fromSequence: 1, toSequence: 0 },
    },
    resumeSessionId: null,
    staleSessionId: null,
    dropped: [],
    refusal: null,
    userSequence: 1,
  };
}

function buildService() {
  const commitProviderSwitch = vi.fn(async () => true);
  const writeSwitchAudit = vi.fn(async () => undefined);
  const service = new ProviderSwitchService(
    { commitProviderSwitch } as never,
    {} as never,
    {} as never,
    {} as never,
    { writeSwitchAudit } as never,
    {} as never,
    { retryErroredTurn: vi.fn() } as never,
  );
  return { service, commitProviderSwitch, writeSwitchAudit };
}

function armedTicket(service: ProviderSwitchService, turnId: string): ProviderSwitchTicket {
  const command = { threadId: THREAD_ID, content: "hello", provider: "codex" } as SendMessageCommand;
  const ticket = service.open(command, "claude");
  if (!ticket) throw new Error("Expected a switching ticket");
  ticket.plan = plannedSwitch();
  service.arm(ticket, { threadId: THREAD_ID, turnId, settings: { provider: "codex", model: "gpt-5.5" } as never });
  return ticket;
}

describe("ProviderSwitchService arm lifecycle", () => {
  it("stops watching when the runtime is released because admission failed", () => {
    const { service, commitProviderSwitch } = buildService();
    const ticket = armedTicket(service, "turn-a");

    ticket.command.onRuntimeReleased?.("admission-failed");
    notifyCommittedCanonicalEvents([event("turn-a", "turn.provider-started")]);

    expect(commitProviderSwitch).not.toHaveBeenCalled();
  });

  it("does not let a stale arm commit for a later turn on the thread", async () => {
    const { service, commitProviderSwitch } = buildService();
    const stale = armedTicket(service, "turn-a");
    const current = armedTicket(service, "turn-b");

    notifyCommittedCanonicalEvents([event("turn-a", "turn.provider-started")]);
    expect(commitProviderSwitch).not.toHaveBeenCalled();

    notifyCommittedCanonicalEvents([event("turn-b", "turn.provider-started")]);
    await current.armed?.committing;
    expect(commitProviderSwitch).toHaveBeenCalledTimes(1);
    expect(stale.armed?.accepted).toBe(false);
  });

  it("forgets a discarded ticket so the thread's arm table does not grow", () => {
    const { service } = buildService();
    const ticket = armedTicket(service, "turn-a");

    service.discard(ticket);

    // The table is the only record of an arm that never reached release, so it must not keep the ticket.
    expect((service as unknown as { armedByThread: Map<string, ProviderSwitchTicket> }).armedByThread.size).toBe(0);
  });
});
