import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentProvider, IProviderRegistry, ProviderId, ProviderModelInfo } from "@mcode/contracts";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { FakeGitExecutor } from "../../../projects/git/execution/fake-git-executor.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../orchestration/agent-turn-command-port.js";
import { TurnRevertStore } from "../persistence/turn-revert-store.js";
import {
  TurnAdmissionDispatchCoordinator,
  type SendMessageCommand,
  type TurnModelCatalog,
  type TurnRuntimeAdmissionAuthority,
} from "../turn-admission-dispatch-coordinator.js";

const FAST_MODEL = "gpt-5.4";
const STANDARD_MODEL = "gpt-5.4-mini";
const catalog: TurnModelCatalog = {
  listModels: async () => [
    { id: FAST_MODEL, name: "GPT-5.4", supportsFastMode: true },
    { id: STANDARD_MODEL, name: "GPT-5.4 Mini", supportsFastMode: false },
  ] satisfies ProviderModelInfo[],
};

let directory: string;
let settings: SettingsService;

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-fast-mode-"));
  vi.stubEnv("MCODE_DATA_DIR", directory);
  settings = new SettingsService();
});
afterEach(async () => {
  settings.dispose();
  await closeAgentStorageTestDatabases();
  vi.unstubAllEnvs();
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

async function fixture(providerId: ProviderId, models: TurnModelCatalog = catalog) {
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const threads = new ThreadRepo(db, writer);
  const workspaces = new WorkspaceRepo(db, writer);
  const messages = new MessageRepo(db, writer);
  const workspace = await workspaces.create("Fast fixture", directory, false);
  const thread = await threads.create(workspace.id, "Fast mode", "direct", "main", false, providerId);
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: providerId, descriptor: { id: providerId, capabilities: [] }, supportsCompletion: false,
    maxInputCharactersPerTurn: 100_000,
    sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {}, listModels: async () => [],
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const worktrees = new GitWorktreeService(workspaces, new FakeGitExecutor(), hostRuntime);
  const client = new CanonicalAgentWriterClient(writer);
  const canonical = new CanonicalAgentBoundary(db, writer, client, () => {});
  const commands = new AgentRuntimeCommandPort();
  const plans = new PlanTurnService(threads, providers, new PlanQuestionService(messages, new PlanQuestionAnswersRepo(db, writer)), new PlanRepo(db, writer), new AgentTurnCommandPort(commands));
  const admission = new TurnAdmissionDispatchCoordinator(
    threads, workspaces, messages, new TurnRevertStore(db), worktrees, new AttachmentService(), providers,
    new ProviderAvailabilityService(settings, providers), canonical, settings, plans,
    new GoalLifecycleService(threads, providers, writer, commands, canonical), undefined, undefined,
    hostRuntime.platform, models,
  );
  const runtime: TurnRuntimeAdmissionAuthority = {
    reserve: () => ({ threadId: thread.id, turnExecutionId: NodeCrypto.randomUUID(), mutationReservationToken: NodeCrypto.randomUUID(), generation: 1 }),
    activate: () => {}, abort: async () => {}, release: () => {}, owns: () => true,
  };
  const send = async (extra: Partial<SendMessageCommand>) => {
    const result = await admission.admit({ threadId: thread.id, content: "Go", messageId: NodeCrypto.randomUUID(), ...extra }, runtime);
    if (result.kind !== "dispatch") throw new Error("Expected provider dispatch");
    return result.request.providerOptions;
  };
  return { send, row: () => threads.findById(thread.id) };
}

describe("turn admission Fast mode", () => {
  it("sends Fast to a model that declares it and keeps it on the thread for later turns", async () => {
    const { send, row } = await fixture("codex");

    expect(await send({ model: FAST_MODEL, fastMode: true })).toEqual({ fastMode: true });
    expect(row()?.fast_mode).toBe(true);
    expect(await send({ model: FAST_MODEL })).toEqual({ fastMode: true });
  });

  it("uses the global Codex default when neither the send nor the thread sets Fast", async () => {
    settings.update({ provider: { codex: { fastMode: true } } });
    const { send, row } = await fixture("codex");

    expect(await send({ model: FAST_MODEL })).toEqual({ fastMode: true });
    expect(row()?.fast_mode).toBeNull();
  });

  it("lets a thread's explicit Fast off override the global default", async () => {
    settings.update({ provider: { codex: { fastMode: true } } });
    const { send } = await fixture("codex");

    expect(await send({ model: FAST_MODEL, fastMode: false })).toEqual({});
    expect(await send({ model: FAST_MODEL })).toEqual({});
  });

  it("never sends Fast to a model that does not declare it", async () => {
    const { send, row } = await fixture("codex");

    expect(await send({ model: STANDARD_MODEL, fastMode: true })).toEqual({});
    expect(row()?.fast_mode).toBe(true);
  });

  it("never sends Fast to another provider's model missing from the catalog", async () => {
    settings.update({ provider: { codex: { fastMode: true } } });
    const { send } = await fixture("claude", { listModels: async () => [] });

    expect(await send({ model: "claude-sonnet-4-6", fastMode: true })).not.toHaveProperty("fastMode");
  });

  it("sends the turn without Fast when the catalog cannot be read", async () => {
    const { send } = await fixture("codex", { listModels: async () => { throw new Error("catalog offline"); } });

    expect(await send({ model: FAST_MODEL, fastMode: true })).toEqual({});
  });
});
