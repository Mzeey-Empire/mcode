import { z } from "zod";
import { ThreadPullRequestSchema } from "@mcode/contracts/models/thread-pull-request";
import { databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";

/** PR mutations admitted only through the link funnel. */
export const threadPullRequestWriteOperations = {
  observe: databaseWriteOperation("threadPullRequests.observe", z.tuple([
    z.string(), z.array(ThreadPullRequestSchema()),
  ]), z.array(ThreadPullRequestSchema()).nullable()),
  forgetBranch: databaseWriteOperation("threadPullRequests.forgetBranch", z.tuple([z.string()]),
    z.array(ThreadPullRequestSchema()).nullable()),
};
