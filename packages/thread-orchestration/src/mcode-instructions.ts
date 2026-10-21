/** Capability-derived runtime guidance shared by every provider adapter. */

/** Codex silently cuts the middle out of an additionalContext value above ~1,000 tokens (UTF-8 bytes / 4). */
export const MCODE_INSTRUCTION_SECTION_MAX_BYTES = 4_000;

const EXPLICIT_MCODE_THREAD_TOKEN = /\b(?:mcode(?:[-_\s]+managed)?[-_\s]+threads?|mcode[-_\s]+thread[-_\s]?control|thread_(?:target_list|create_batch|search|get|send|stop|wait)|delegate_task|task_(?:status|cancel))\b/i;
const NEGATION = /\b(?:do\s+not|don['’]?t|dont|never|without|no)\b/i;
const SENTENCE_BOUNDARY = /[.!?]+\s+(?=[A-Z])/;
const MCODE_THREAD_REQUEST_ACTION = /\b(?:create|start|open|launch|use|manage|list|search|send|stop|wait|get|target|delegate|call|check|cancel)\b/i;

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

/**
 * Returns true only when the user's current request explicitly names Mcode
 * thread control or one of its thread operations.
 *
 * Provider-native child-agent language intentionally does not satisfy this
 * boundary. A sentence asks for thread control only through the text before
 * its first negation, so "do not create an Mcode thread" grants nothing while
 * an unrelated "don't wait on it" in another sentence does not revoke an
 * explicit request. A sentence ends only at terminal punctuation followed by
 * whitespace and a capital letter, so paths, versions and line breaks cannot
 * split a negated request into an affirmative one.
 */
export function isExplicitMcodeThreadRequest(content: string): boolean {
  return content.split(SENTENCE_BOUNDARY).some((sentence) => {
    const affirmative = sentence.split(NEGATION, 1)[0] ?? "";
    return EXPLICIT_MCODE_THREAD_TOKEN.test(affirmative) && MCODE_THREAD_REQUEST_ACTION.test(affirmative);
  });
}

const IDENTITY_BLOCK = [
  "You are operating inside an Mcode-managed session.",
  "Mcode runtime guidance is advisory; MCP authorization and lease state remain authoritative.",
].join(" ");

// The thread-control and Browser tool descriptions repeat these rules on purpose. With deferred tool loading, a description arrives only after the model has chosen a tool.
const THREAD_CONTROL_BLOCK = [
  "Mcode thread control",
  "- Use the mcode MCP thread_* tools only when the user explicitly asks for Mcode threads. An Mcode thread is a persistent user-visible conversation, different from provider-native child agents.",
  "- If no Project is named, use the active source thread's Project without discovery. Resolve an explicitly named Project with workspace_search. Use worktree_list only to resolve an explicit worktree or reference.",
  "- Delegate child work with delegate_task. Preserve the user's title and task in the prompt. Choose isolation shared for the Coordinator's checkout or worktree for a new checkout at its local commit. Retry the same input with the same clientRequestId to return the existing task.",
  "- Call thread_target_list before choosing a provider or model, and pass the exact returned providerId and modelId. Pass any named provider or execution setting. Never assume or enumerate providers or models.",
  "- Use returned taskId and threadId references for follow-up work. delegate_task returns immediately: end the turn or continue other work and check later with task_status rather than polling in a loop. Use task_cancel to stop delegated work and thread_get to inspect its thread. Run each review round as a fresh task carrying the brief, prior findings and open objections.",
  "- Never target the active source thread. Keep prompts faithful to the user's request and inspect results before sending follow-up work.",
  "- If these tools are missing from an initial tool listing, they may load lazily. Make one direct attempt before reporting them unavailable.",
].join("\n");

const PROVIDER_SUBAGENT_BLOCK = [
  "A child-agent or sub-agent request uses provider-native collaboration in the current turn.",
  "Use collaboration tools, preserve the exact requested brief, and keep direct and nested parent relationships intact.",
  "A child-agent request does not authorize Mcode thread control; use thread tools only for an explicit Mcode thread request.",
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

const BROWSER_BLOCK = [
  "Mcode Browser",
  "- Boundary: for visible Browser or Mcode Preview requests, use only the mcode MCP browser_* tools. Never use bundled generic Browser, Chrome, Playwright or Node-REPL, and never launch another browser or profile.",
  "- Browser-only tasks need no shell commands or local skill files. Keep narration minimal.",
  "- Open: browser_open creates a sticky, agent-owned background tab and returns tab metadata and an observationRef, not a page observation.",
  "- Inspect: browser_inspect is authoritative for readiness, tabs, capabilities, constraints, diagnostics, revision and observationRef. Inspect before the first action unless browser_open returned enough snapshot evidence. Tool discovery does not prove readiness.",
  "- Target: use a semanticId from the latest inspection, then role plus accessibleName. Use CSS or coordinates only when no semantic target exists. Never guess an ambiguous target.",
  "- Act: browser_act needs the latest observationRef, a fresh idempotencyKey, deadlineMs and a non-empty steps array, at most eight steps and 60 seconds. Never send `steps: []`.",
  "- Verify: stop on failure, interruption, deadline or invalidation. Verify non-navigation effects with an assert step or a fresh inspection. Navigation and reload end the batch, so inspect again before another mutation.",
  "- Interruptions: user input invalidates the observation. Stop or Take control interrupts execution, and Take control holds the Browser until Hand back. Release held input, keep completed effects and yield to the user.",
  "- Recover: inspect the receipt and effect before retrying. Effects do not roll back, so never replay mutations automatically. Follow exactly one recovery instruction: inspect, reopen, wait, yield_to_user or do_not_retry.",
  "- Evidence: request includeScreenshot only for visual evidence or when the user asks. Verify every success claim against current page evidence.",
  "- Finish: call browser_tabs finalize before replying. Release claimed user tabs and close agent tabs by default. For a tab the user wants open, set disposition handoff and verify success.",
  "- Evaluate: use browser_evaluate only when the live capability advertises it. All rules above apply.",
  "- If these tools are missing from an initial tool listing, they may load lazily. Make one direct attempt before reporting them unavailable.",
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
