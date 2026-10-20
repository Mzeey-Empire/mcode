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
  };
}

function buildService() {
  const commitProviderSwitch = vi.fn(async () => true);
  const writeHandoffAudit = vi.fn(async () => undefined);
  const execute = vi.fn(async () => undefined);
  const service = new ProviderSwitchService(
    { commitProviderSwitch } as never,
    {} as never,
    {} as never,
    {} as never,
    { writeHandoffAudit } as never,
    {} as never,
    { retryErroredTurn: vi.fn() } as never,
    { execute } as never,
  );
  return { service, commitProviderSwitch, writeHandoffAudit, execute };
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

  it("saves the switch on a second try when the first write fails", async () => {
    const { service, commitProviderSwitch, writeHandoffAudit, execute } = buildService();
    commitProviderSwitch.mockRejectedValueOnce(new Error("database is locked"));
    const ticket = armedTicket(service, "turn-a");

    notifyCommittedCanonicalEvents([event("turn-a", "turn.provider-started")]);
    await ticket.armed?.committing;

    expect(commitProviderSwitch).toHaveBeenCalledTimes(2);
    expect(writeHandoffAudit).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("tells the user in the timeline when the accepted switch cannot be saved", async () => {
    const { service, commitProviderSwitch, writeHandoffAudit, execute } = buildService();
    commitProviderSwitch.mockRejectedValue(new Error("database is locked"));
    const ticket = armedTicket(service, "turn-a");

    notifyCommittedCanonicalEvents([event("turn-a", "turn.provider-started")]);
    await ticket.armed?.committing;

    expect(commitProviderSwitch).toHaveBeenCalledTimes(2);
    expect(writeHandoffAudit).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      threadId: THREAD_ID,
      content: expect.stringContaining("not saved"),
      notice: { kind: "warning", presentation: "timeline" },
    });
  });

  it("forgets a discarded ticket so the thread's arm table does not grow", () => {
    const { service } = buildService();
    const ticket = armedTicket(service, "turn-a");

    service.discard(ticket);

    // The table is the only record of an arm that never reached release, so it must not keep the ticket.
    expect((service as unknown as { armedByThread: Map<string, ProviderSwitchTicket> }).armedByThread.size).toBe(0);
  });
});
