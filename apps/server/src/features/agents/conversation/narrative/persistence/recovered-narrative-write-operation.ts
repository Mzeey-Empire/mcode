import { z } from "zod";
import { ParentNarrativeRecoveryItemSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../../runtime/persistence/sqlite/database-write-operation.js";

/** Recovered message details commit together, including all three narrative record tables. */
export const recoveredNarrativeWriteOperation = databaseWriteOperation(
  "narrative.persistRecovered",
  z.tuple([z.string(), z.array(ParentNarrativeRecoveryItemSchema()), z.boolean()]),
  z.void(),
);
