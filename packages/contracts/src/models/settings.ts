import { z } from "zod";
import { InteractionModeSchema, PermissionModeSchema } from "./enums.js";
import { lazySchema } from "../utils/lazySchema.js";

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

/** UI theme preference. */
export const ThemeSchema = z.enum(["system", "dark", "light"]);
/** UI theme preference value. */
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * Default agent interaction mode.
 *
 * Extends the base InteractionMode with an "agent" option that grants
 * autonomous multi-step execution capabilities.
 */
export const AgentDefaultModeSchema = z.enum([
  ...InteractionModeSchema.options,
  "agent",
]);
/** Default agent interaction mode value. */
export type AgentDefaultMode = z.infer<typeof AgentDefaultModeSchema>;

/**
 * Reasoning effort level for model inference.
 * "max" maps to Claude's extended thinking; "xhigh" maps to Codex's xhigh effort tier and Claude Opus 4.7+;
 * "ultrathink" is a virtual top-tier that prepends "Ultrathink:\n" to the user prompt and
 * sends "max" effort to the SDK. Supported only by max-tier Claude models (Opus 4.7/4.6, Sonnet 4.6).
 */
export const ReasoningLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultrathink",
]);
/** Reasoning effort level value. */
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/**
 * Context window selection for Claude models that support an extended 1M tier.
 * "200k" is the default tier every Claude model supports; "1m" requests the
 * 1,000,000-token tier (only honored for Opus 4.7/4.6 and Sonnet 4.6).
 *
 * At send time the server appends a `[1m]` suffix to the model slug to opt
 * into the extended window via the Claude Agent SDK; the SDK forwards the
 * appropriate beta header internally.
 */
export const ContextWindowModeSchema = z.enum(["200k", "1m"]);
/** Context window selection value. */
export type ContextWindowMode = z.infer<typeof ContextWindowModeSchema>;

/** Supported AI provider identifier for settings. */
export const ProviderIdSchema = z.enum(["claude", "codex", "gemini", "copilot", "cursor"]);
/** Supported AI provider identifier value. */
export type SettingsProviderId = z.infer<typeof ProviderIdSchema>;

/** Worktree branch naming strategy. */
export const NamingModeSchema = z.enum(["auto", "custom", "ai"]);
/** Worktree branch naming strategy value. */
export type NamingMode = z.infer<typeof NamingModeSchema>;

/** Auto-update check interval. */
export const UpdateCheckIntervalSchema = z.enum(["15min", "1hour", "4hours", "1day", "never"]);
/** Auto-update check interval value. */
export type UpdateCheckInterval = z.infer<typeof UpdateCheckIntervalSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default grace-period seconds before the server auto-shuts down after all
 * sessions disconnect. Shared between the schema default and the
 * mode-aware resolver in `grace-period-ms.ts`.
 */
export const GRACE_PERIOD_DEFAULT_SECONDS = 30;

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

/** Schema for the full user settings object. Every field has a default. */
export const SettingsSchema = lazySchema(() =>
  z.object({
    /** Visual appearance settings. */
    appearance: z
      .object({
        /** Color theme preference. */
        theme: ThemeSchema.default("system"),
      })
      .default({}),

    /** Agent orchestration settings. */
    agent: z
      .object({
        /** Maximum number of concurrent agent sessions. */
        maxConcurrent: z.number().int().positive().default(5),
        /** Default values for new agent sessions. */
        defaults: z
          .object({
            /** Default interaction mode. */
            mode: AgentDefaultModeSchema.default("chat"),
            /** Default permission mode. */
            permission: PermissionModeSchema.default("full"),
          })
          .default({}),
        /** Per-session safety limits (Claude provider only). */
        guardrails: z
          .object({
            /** Stop the agent if session cost exceeds this USD amount. 0 disables. */
            maxBudgetUsd: z.number().nonnegative().finite().default(0),
            /** Stop the agent after this many turns. 0 disables. */
            maxTurns: z.number().int().nonnegative().default(0),
          })
          .default({}),
      })
      .default({}),

    /** Model inference settings. */
    model: z
      .object({
        /** Default values for model selection. */
        defaults: z
          .object({
            /** Default AI provider. */
            provider: ProviderIdSchema.default("claude"),
            /** Default model identifier. */
            id: z.string().default("claude-opus-4-7"),
            /** Default reasoning effort level. */
            reasoning: ReasoningLevelSchema.default("high"),
            /** Fallback model when the primary is unavailable. Empty string disables fallback. */
            fallbackId: z.string().trim().default("claude-sonnet-4-6"),
            /**
             * Default context window mode. "200k" is the universally supported tier;
             * "1m" requests the extended 1M-token window from Opus 4.7/4.6 and Sonnet 4.6.
             * Models that do not support 1M ignore this and run on 200k.
             */
            contextWindow: ContextWindowModeSchema.default("200k"),
            /**
             * Default boolean thinking toggle. Honored only by models that expose
             * thinking as a boolean (Haiku 4.5). Effort-tier models ignore this and
             * use their reasoning level instead.
             */
            thinking: z.boolean().default(false),
          })
          .default({}),
        /** Provider and model for lightweight utility tasks (PR drafts, diff summaries, etc.). */
        utility: z
          .object({
            /** AI provider for utility tasks. Empty string inherits from model.defaults.provider. */
            provider: ProviderIdSchema.or(z.literal("")).default(""),
            /** Model ID for utility tasks. Empty string selects a provider-appropriate cheap default. */
            id: z.string().default(""),
          })
          .default({}),
      })
      .default({}),

    /** Terminal emulator settings. */
    terminal: z
      .object({
        /**
         * Number of scrollback lines to retain per terminal instance.
         * Values above 5000 are clamped to 5000 (rather than rejected) so that
         * users with legacy settings from before the cap was introduced do not
         * have their entire settings object silently reset by the server's
         * safeParse fallback at settings-service.ts:94.
         * Zero means unlimited (not recommended for long-running sessions).
         * Negative or non-integer values are still rejected as invalid input.
         */
        scrollback: z
          .number()
          .int()
          .nonnegative()
          .transform((n) => Math.min(n, 5000))
          .default(1000),
        /**
         * When to prompt for confirmation before killing a terminal with
         * running child processes.
         *
         * - "never"  — kill immediately, no prompt (default, preserves prior behaviour)
         * - "panel"  — prompt when the bin button is clicked in the terminal panel
         * - "always" — prompt in all kill paths
         * - "editor" — reserved for future use; currently behaves like "panel"
         */
        confirmOnKill: z
          .enum(["never", "editor", "panel", "always"])
          .default("never"),
        /** Flow control settings for PTY backpressure handling. */
        flowControl: z
          .object({
            /** Server-side high-water mark in bytes. Pause PTY drain when ws.bufferedAmount exceeds this. */
            serverHighBytes: z.number().int().positive(),
            /** Server-side low-water mark in bytes. Resume PTY drain when ws.bufferedAmount drops below this. */
            serverLowBytes: z.number().int().positive(),
            /** Client-side high-water mark in bytes. Send terminal.pause when xterm write backlog exceeds this. */
            clientHighBytes: z.number().int().positive(),
            /** Client-side low-water mark in bytes. Send terminal.resume when xterm write backlog drops below this. */
            clientLowBytes: z.number().int().positive(),
          })
          .refine((v) => v.serverLowBytes < v.serverHighBytes, {
            message: "serverLowBytes must be less than serverHighBytes",
          })
          .refine((v) => v.clientLowBytes < v.clientHighBytes, {
            message: "clientLowBytes must be less than clientHighBytes",
          })
          .default({
            serverHighBytes: 1_048_576,
            serverLowBytes: 262_144,
            clientHighBytes: 262_144,
            clientLowBytes: 65_536,
          }),
      })
      .default({}),

    /** Notification settings. */
    notifications: z
      .object({
        /** Whether desktop notifications are enabled. */
        enabled: z.boolean().default(true),
      })
      .default({}),

    /** Git worktree settings. */
    worktree: z
      .object({
        /** Branch naming settings for new worktrees. */
        naming: z
          .object({
            /** Naming strategy for new worktree branches. */
            mode: NamingModeSchema.default("auto"),
            /** Whether to prompt for confirmation when using AI-generated names. */
            aiConfirmation: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),

    /** Server child process settings. */
    server: z
      .object({
        /** Memory settings for the server process. */
        memory: z
          .object({
            /** V8 max old space size in MB. Valid range: 64-8192. Default tuned for < 100MB idle. */
            heapMb: z.number().int().min(64).max(8192).default(96),
          })
          .default({}),
        /** Grace period before auto-shutdown after all UI sessions disconnect. */
        gracePeriod: z
          .object({
            /** Seconds to wait. 0 shuts down immediately. Max 300 (5 minutes). */
            seconds: z.number().int().min(0).max(300).default(GRACE_PERIOD_DEFAULT_SECONDS),
          })
          .default({}),
      })
      .default({}),

    /** Provider-specific configuration. */
    provider: z
      .object({
        /** Per-provider enable flag. Disabled providers cannot start new sessions. */
        enabled: z
          .object({
            claude: z.boolean().default(true),
            codex: z.boolean().default(true),
            copilot: z.boolean().default(true),
            gemini: z.boolean().default(false),
            cursor: z.boolean().default(false),
            opencode: z.boolean().default(false),
          })
          .default({}),
        /** CLI binary paths. Empty string means auto-discover from PATH. */
        cli: z
          .object({
            /** Path to the Codex CLI binary. Empty uses PATH lookup. */
            codex: z.string().default(""),
            /** Path to the Claude CLI binary. Empty uses PATH lookup. */
            claude: z.string().default(""),
            /** Path to the Copilot CLI binary. Empty uses PATH lookup. */
            copilot: z.string().default(""),
            /** Path to the Cursor Agent CLI (`cursor-agent` / `agent`). Empty uses PATH lookup. */
            cursor: z.string().default(""),
          })
          .default({}),
      })
      .default({}),

    /** PR draft generation settings. */
    prDraft: z
      .object({})
      .default({}),

    /** Diff summary generation settings. */
    diffSummary: z
      .object({
        /** Enable the AI-generated Summary tab in the diff panel. */
        enabled: z.boolean().default(false),
      })
      .default({}),

    /** Runtime performance and resource-usage settings. */
    performance: z
      .object({
        /**
         * Maximum number of threads kept in the in-memory message cache.
         * Higher values reduce thread-switch latency at the cost of memory;
         * lower values free memory at the cost of more getMessages round-trips.
         */
        threadCacheSize: z.number().int().min(1).max(25).default(10),
      })
      .default({}),

    /** App auto-update settings. */
    updates: z
      .object({
        /** Whether to automatically download available updates. */
        autoDownload: z.boolean().default(true),
        /** Whether to automatically install updates when the app quits. */
        autoInstallOnQuit: z.boolean().default(true),
        /** How often to check for updates. */
        checkInterval: UpdateCheckIntervalSchema.default("4hours"),
      })
      .default({}),
  }),
);

/** Full settings object with all defaults applied. */
export type Settings = z.infer<ReturnType<typeof SettingsSchema>>;

/** Returns a fresh default settings object by parsing an empty input. */
export function getDefaultSettings(): Settings {
  return SettingsSchema().parse({});
}

// ---------------------------------------------------------------------------
// Partial settings schema (for deep-partial updates)
// ---------------------------------------------------------------------------

/**
 * Deep-partial settings schema for incremental updates via `settings.update`.
 *
 * Hand-authored with `.optional()` instead of `.default()` so that absent
 * fields remain `undefined` after parsing rather than being backfilled with
 * schema defaults. Using `SettingsSchema().deepPartial()` would preserve
 * the `.default()` wrappers, causing Zod to inject default values for every
 * omitted sibling when a parent object is present in the input.
 */
export const PartialSettingsSchema = lazySchema(() =>
  z.object({
    appearance: z
      .object({
        theme: ThemeSchema.optional(),
      })
      .optional(),
    agent: z
      .object({
        maxConcurrent: z.number().int().positive().optional(),
        defaults: z
          .object({
            mode: AgentDefaultModeSchema.optional(),
            permission: PermissionModeSchema.optional(),
          })
          .optional(),
        guardrails: z
          .object({
            maxBudgetUsd: z.number().nonnegative().finite().optional(),
            maxTurns: z.number().int().nonnegative().optional(),
          })
          .optional(),
      })
      .optional(),
    model: z
      .object({
        defaults: z
          .object({
            provider: ProviderIdSchema.optional(),
            id: z.string().optional(),
            reasoning: ReasoningLevelSchema.optional(),
            fallbackId: z.string().trim().optional(),
            contextWindow: ContextWindowModeSchema.optional(),
            thinking: z.boolean().optional(),
          })
          .optional(),
        utility: z
          .object({
            provider: ProviderIdSchema.or(z.literal("")).optional(),
            id: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    terminal: z
      .object({
        scrollback: z
          .number()
          .int()
          .nonnegative()
          .transform((n) => Math.min(n, 5000))
          .optional(),
        confirmOnKill: z.enum(["never", "editor", "panel", "always"]).optional(),
        flowControl: z
          .object({
            serverHighBytes: z.number().int().positive().optional(),
            serverLowBytes: z.number().int().positive().optional(),
            clientHighBytes: z.number().int().positive().optional(),
            clientLowBytes: z.number().int().positive().optional(),
          })
          .optional(),
      })
      .optional(),
    notifications: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    worktree: z
      .object({
        naming: z
          .object({
            mode: NamingModeSchema.optional(),
            aiConfirmation: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    server: z
      .object({
        memory: z
          .object({
            heapMb: z.number().int().min(64).max(8192).optional(),
          })
          .optional(),
        gracePeriod: z
          .object({
            seconds: z.number().int().min(0).max(300).optional(),
          })
          .optional(),
      })
      .optional(),
    provider: z
      .object({
        enabled: z
          .object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            copilot: z.boolean().optional(),
            gemini: z.boolean().optional(),
            cursor: z.boolean().optional(),
            opencode: z.boolean().optional(),
          })
          .optional(),
        cli: z
          .object({
            codex: z.string().optional(),
            claude: z.string().optional(),
            copilot: z.string().optional(),
            cursor: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    prDraft: z.object({}).optional(),
    diffSummary: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    performance: z
      .object({
        threadCacheSize: z.number().int().min(1).max(25).optional(),
      })
      .optional(),
    updates: z
      .object({
        autoDownload: z.boolean().optional(),
        autoInstallOnQuit: z.boolean().optional(),
        checkInterval: UpdateCheckIntervalSchema.optional(),
      })
      .optional(),
  }),
);

/** Deep-partial settings for incremental updates. */
export type PartialSettings = z.infer<ReturnType<typeof PartialSettingsSchema>>;
