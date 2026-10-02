import { sql, type SQL } from "drizzle-orm";
import {
  canonicalAgentIngestCheckpoints,
  canonicalAgentThreads,
  canonicalAgentTurns,
} from "../../../runtime/persistence/sqlite/schema.js";

/** Provider-owned child turns finish through collaboration observations without writer checkpoints. */
export function terminalProviderChildTurnCondition(turnId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${canonicalAgentTurns} child_turn
    JOIN ${canonicalAgentThreads} child_thread ON child_thread.id = child_turn.thread_id
    WHERE child_turn.id = ${turnId}
      AND child_thread.parent_thread_id IS NOT NULL
      AND child_thread.owning_parent_thread_id IS NOT NULL
      AND json_extract(child_turn.trigger_json, '$.kind') = 'child'
      AND child_turn.status IN ('Completed', 'Cancelled', 'Interrupted', 'Errored')
      AND NOT EXISTS (
        SELECT 1 FROM ${canonicalAgentIngestCheckpoints} child_checkpoint
        WHERE child_checkpoint.execution_id = child_turn.execution_id
          AND child_checkpoint.turn_id = child_turn.id
      )
  )`;
}

/** Worker-owned responses retain their checkpoint gate; provider children use their exact terminal turn. */
export function terminalAssistantProjectionCondition(turnId: SQL): SQL {
  return sql`(EXISTS (
    SELECT 1 FROM ${canonicalAgentIngestCheckpoints} checkpoint
    WHERE checkpoint.turn_id = ${turnId}
      AND checkpoint.terminal_outcome IS NOT NULL
  ) OR ${terminalProviderChildTurnCondition(turnId)})`;
}
