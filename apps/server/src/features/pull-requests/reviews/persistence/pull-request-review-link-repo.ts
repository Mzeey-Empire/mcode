import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { PullRequestReviewLinkStore } from "./pull-request-review-link-store.js";
import { reviewWriteOperations } from "./review-write-operations.js";
export type { PullRequestReviewLinkIdentity, PullRequestReviewLink, CreatePullRequestReviewLinkInput, ReplacePullRequestReviewCheckoutInput, UpdatePullRequestReviewRemoteStateInput } from "./pull-request-review-link-store.js";

/** Read-only queries and committed mutations for PullRequestReviewLinkRepo. */
@injectable()
export class PullRequestReviewLinkRepo {
  private readonly reader: PullRequestReviewLinkStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new PullRequestReviewLinkStore(db);
  }

  persistReviewTask(input: Parameters<PullRequestReviewLinkStore["persistReviewTask"]>[0]): Promise<ReturnType<PullRequestReviewLinkStore["persistReviewTask"]>> {
    return this.writer.execute(reviewWriteOperations.persistReviewTask, [input]);
  }

  findByIdentity(identity: Parameters<PullRequestReviewLinkStore["findByIdentity"]>[0]): ReturnType<PullRequestReviewLinkStore["findByIdentity"]> {
    return this.reader.findByIdentity(identity);
  }

  findByPrimaryThreadId(threadId: Parameters<PullRequestReviewLinkStore["findByPrimaryThreadId"]>[0]): ReturnType<PullRequestReviewLinkStore["findByPrimaryThreadId"]> {
    return this.reader.findByPrimaryThreadId(threadId);
  }

  findByWorktreePath(worktreePath: Parameters<PullRequestReviewLinkStore["findByWorktreePath"]>[0], pullRequestNumber: Parameters<PullRequestReviewLinkStore["findByWorktreePath"]>[1]): ReturnType<PullRequestReviewLinkStore["findByWorktreePath"]> {
    return this.reader.findByWorktreePath(worktreePath, pullRequestNumber);
  }

  insert(input: Parameters<PullRequestReviewLinkStore["insert"]>[0]): Promise<ReturnType<PullRequestReviewLinkStore["insert"]>> {
    return this.writer.execute(reviewWriteOperations.insert, [input]);
  }

  replaceLocalCheckout(identity: Parameters<PullRequestReviewLinkStore["replaceLocalCheckout"]>[0], input: Parameters<PullRequestReviewLinkStore["replaceLocalCheckout"]>[1]): Promise<ReturnType<PullRequestReviewLinkStore["replaceLocalCheckout"]>> {
    return this.writer.execute(reviewWriteOperations.replaceLocalCheckout, [this.writeIdentity(identity), input]);
  }

  updateRemoteState(identity: Parameters<PullRequestReviewLinkStore["updateRemoteState"]>[0], input: Parameters<PullRequestReviewLinkStore["updateRemoteState"]>[1]): Promise<ReturnType<PullRequestReviewLinkStore["updateRemoteState"]>> {
    return this.writer.execute(reviewWriteOperations.updateRemoteState, [this.writeIdentity(identity), input]);
  }

  updatePrimaryThread(identity: Parameters<PullRequestReviewLinkStore["updatePrimaryThread"]>[0], primaryThreadId: Parameters<PullRequestReviewLinkStore["updatePrimaryThread"]>[1]): Promise<ReturnType<PullRequestReviewLinkStore["updatePrimaryThread"]>> {
    return this.writer.execute(reviewWriteOperations.updatePrimaryThread, [this.writeIdentity(identity), primaryThreadId]);
  }

  clearPrimaryThreadByThreadId(threadId: Parameters<PullRequestReviewLinkStore["clearPrimaryThreadByThreadId"]>[0]): Promise<ReturnType<PullRequestReviewLinkStore["clearPrimaryThreadByThreadId"]>> {
    return this.writer.execute(reviewWriteOperations.clearPrimaryThreadByThreadId, [threadId]);
  }

  private writeIdentity(identity: Parameters<PullRequestReviewLinkStore["findByIdentity"]>[0]): Parameters<PullRequestReviewLinkStore["findByIdentity"]>[0] {
    return { provider: identity.provider, repositoryNodeId: identity.repositoryNodeId, pullRequestNumber: identity.pullRequestNumber };
  }
}
