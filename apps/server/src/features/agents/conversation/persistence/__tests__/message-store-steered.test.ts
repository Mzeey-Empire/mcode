import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { TurnSteerStore } from "../../../steering/persistence/turn-steer-store.js";
import { MessageStore } from "../message-store.js";

const THREAD = "thread-1";
const EXECUTION = "00000000-0000-4000-8000-000000000001";

describe("MessageStore.isLatestNonSystemMessage with steers", () => {
  let directory: string;
  let db: Database;
  let messages: MessageStore;
  let steers: TurnSteerStore;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-message-steered-"));
    db = openDatabase({ dbPath: NodePath.join(directory, "app.sqlite") });
    db.run("INSERT INTO workspaces (id,name,path) VALUES (?,?,?)", ["workspace-1", "Fixture", directory]);
    db.run("INSERT INTO threads (id,workspace_id,title,branch,provider) VALUES (?,?,?,?,?)",
      [THREAD, "workspace-1", "Fixture", "main", "codex"]);
    messages = new MessageStore(db);
    steers = new TurnSteerStore(db);
  });

  afterEach(() => {
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function steer(messageId: string, settle?: "rejected" | "delivered") {
    steers.insertPending({ messageId, threadId: THREAD, turnExecutionId: EXECUTION, inputsHash: "hash",
      payload: { content: "Use staging" } });
    if (settle === "rejected") {
      steers.settle(messageId, { state: "rejected", rejection: { code: "turn_not_running" } });
    }
    if (settle === "delivered") steers.markDelivered(messageId);
  }

  it("skips only delivered steers, so a refused steer sent later as a prompt still anchors its turn", () => {
    const prompt = messages.create(THREAD, "user", "Start", 1);
    const delivered = "00000000-0000-4000-8000-0000000000d1";
    steer(delivered, "delivered");
    messages.create(THREAD, "user", "Use staging", 2, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, delivered);
    expect(messages.isLatestNonSystemMessage(THREAD, prompt.id)).toBe(true);

    const refused = "00000000-0000-4000-8000-0000000000e1";
    steer(refused, "rejected");
    messages.create(THREAD, "user", "Use staging", 3, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, refused);
    expect(messages.isLatestNonSystemMessage(THREAD, refused)).toBe(true);
    expect(messages.isLatestNonSystemMessage(THREAD, prompt.id)).toBe(false);
  });
});
