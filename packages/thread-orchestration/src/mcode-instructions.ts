/** Capability-derived runtime guidance shared by every provider adapter. */

/** Codex silently cuts the middle out of an additionalContext value above ~1,000 tokens (UTF-8 bytes / 4). */
export const MCODE_INSTRUCTION_SECTION_MAX_BYTES = 4_000;

/** Stable section names used as Codex context tags. */
export type McodeInstructionSectionKey =
  | "mcode_identity"
  | "mcode_provider_subagents"
  | "mcode_nested_delegation"
  | "mcode_thread_control"
  | "mcode_browser"
  | "mcode_repository_search";

/** One self-contained concern delivered through a provider's native context. */
export interface McodeInstructionSection {
  readonly key: McodeInstructionSectionKey;
  readonly text: string;
}

/** Toolkits attached to one provider session. */
export interface McodeAttachedToolkits {
  readonly threadControl: boolean;
  readonly browser: boolean;
}

/** Inputs for selecting runtime guidance after provider setup succeeds. */
export interface BuildMcodeInstructionSectionsInput {
  readonly toolkits: McodeAttachedToolkits;
  /** Optional provider-native model to use when a child must spawn another child. */
  readonly nestedDelegationModel?: string;
}

const IDENTITY_BLOCK = [
  "You are operating inside an Mcode-managed session.",
  "Mcode runtime guidance is advisory; MCP authorization and lease state remain authoritative.",
].join(" ");

// The thread-control tool descriptions repeat these rules on purpose. With deferred tool loading, a description arrives only after the model has chosen a tool.
const THREAD_CONTROL_BLOCK = [
  "Mcode thread control",
  "- The mcode MCP tools manage Mcode threads: persistent, user-visible conversations. Use delegate_task when the user asks to hand work to another provider or model, even if they never say \"Mcode thread\".",
  "- A sub-agent request uses your provider-native collaboration tool when it can run the requested model. Never launch an Mcode thread just because the user said \"sub-agent\".",
  "- If no Project is named, use the active source thread's Project without discovery. Resolve an explicitly named Project with workspace_search. Use worktree_list only to resolve an explicit worktree or reference.",
  "- Delegate child work with delegate_task. Preserve the user's title and task in the prompt. Choose isolation shared for the Coordinator's checkout or worktree for a new checkout at its local commit. Retry the same input with the same clientRequestId to return the existing task.",
  "- thread_launch starts a separate user-owned thread only when the user asks for one; use delegate_task for child work whose result you need.",
  "- Call thread_target_list before choosing a provider or model, and pass the exact returned providerId and modelId. Pass any named provider or execution setting. Never assume or enumerate providers or models.",
  "- Use returned taskId and threadId references for follow-up work. delegate_task returns immediately: end the turn or continue other work and check later with task_status rather than polling in a loop. Use task_cancel to stop delegated work and thread_get to inspect its thread. Run each review round as a fresh task carrying the brief, prior findings and open objections.",
  "- Never target the active source thread. Keep prompts faithful to the user's request and inspect results before sending follow-up work.",
  "- If these tools are missing from an initial tool listing, they may load lazily. Make one direct attempt before reporting them unavailable.",
].join("\n");

const PROVIDER_SUBAGENT_BLOCK = [
  "A child-agent or sub-agent request uses provider-native collaboration in the current turn.",
  "Use collaboration tools, preserve the exact requested brief, and keep direct and nested parent relationships intact.",
  "Use Mcode delegation for a child-agent request only when native collaboration cannot run the requested provider or model.",
].join(" ");

const REPOSITORY_SEARCH_BLOCK = [
  "For broad repository searches, first list files with rg -l.",
  "Exclude fixtures and captured traces (*.ndjson) unless the task targets them, and bound line output with rg --max-columns 240 before reading matches.",
].join(" ");

function nestedDelegationBlock(model: string | undefined): string | undefined {
  const candidate = model?.trim();
  if (!candidate) return undefined;
  return [
    "When an explicitly requested provider-native child must spawn its own provider-native child, pass the nested-capable model",
    `"${candidate}"`,
    "in the parent spawn_agent call. Do not replace provider-native collaboration with shell commands or Mcode thread tools.",
  ].join(" ");
}

// Routing rules only: they decide which browser the model picks, which happens before any Browser tool description is loaded. Operating rules live in the tool descriptions.
const BROWSER_BLOCK = [
  "Mcode Browser",
  "- Prefer the mcode MCP browser_* tools for any browser work. They drive the Browser the user sees.",
  "- Before concluding the Browser is unavailable, check its status with browser_inspect and open a tab with browser_open. If the tools are missing from an initial tool listing, they may load lazily; make one direct attempt.",
  "- When the user means the page they have open, read their tab instead of opening a new one.",
  "- After a first failure, follow the error's recovery instruction in Mcode's Browser. Do not switch to another browser, Chrome, Playwright or Node-REPL.",
  "- Switch only after two failures on the same step, or when the user asks. Quote the raw error when you switch.",
  "- A user hold, Stop or do_not_retry is not a failure to work around: yield to the user instead of switching.",
].join("\n");

const SECTION_REGISTRY: readonly {
  key: McodeInstructionSectionKey;
  text(input: BuildMcodeInstructionSectionsInput): string | undefined;
}[] = [
  { key: "mcode_identity", text: () => IDENTITY_BLOCK },
  { key: "mcode_provider_subagents", text: () => PROVIDER_SUBAGENT_BLOCK },
  { key: "mcode_nested_delegation", text: (input) => nestedDelegationBlock(input.nestedDelegationModel) },
  { key: "mcode_thread_control", text: (input) => input.toolkits.threadControl ? THREAD_CONTROL_BLOCK : undefined },
  { key: "mcode_browser", text: (input) => input.toolkits.browser ? BROWSER_BLOCK : undefined },
  { key: "mcode_repository_search", text: () => REPOSITORY_SEARCH_BLOCK },
];

/** Builds ordered, self-contained guidance from the session's attached toolkits. */
export function buildMcodeInstructionSections(
  input: BuildMcodeInstructionSectionsInput,
): readonly McodeInstructionSection[] {
  return SECTION_REGISTRY.flatMap(({ key, text }) => {
    const sectionText = text(input);
    return sectionText === undefined ? [] : [{ key, text: sectionText }];
  });
}

/** Joins sections for providers with a single native instruction field. */
export function renderMcodeInstructionSections(sections: readonly McodeInstructionSection[]): string {
  return sections.map((section) => section.text).join("\n\n");
}
