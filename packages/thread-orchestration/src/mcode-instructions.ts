/** Capability-derived runtime guidance shared by every provider adapter. */

/** Codex silently cuts the middle out of an additionalContext value above ~1,000 tokens (UTF-8 bytes / 4). */
export const MCODE_INSTRUCTION_SECTION_MAX_BYTES = 4_000;

const EXPLICIT_MCODE_THREAD_TOKEN = /\b(?:mcode(?:[-_\s]+managed)?[-_\s]+threads?|mcode[-_\s]+thread[-_\s]?control|thread_(?:target_list|create_batch|search|get|send|stop|wait))\b/i;
const NEGATED_MCODE_THREAD_REQUEST = /\b(?:do\s+not|don['’]?t|dont|never|without|no)\b[\s\S]{0,96}\b(?:mcode(?:[-_\s]+managed)?[-_\s]+threads?|mcode[-_\s]+thread[-_\s]?control|thread_(?:target_list|create_batch|search|get|send|stop|wait))\b/i;
const MCODE_THREAD_REQUEST_ACTION = /\b(?:create|start|open|launch|use|manage|list|search|send|stop|wait|get|target|delegate)\b/i;

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
 * boundary. Negated requests fail closed so a model cannot inherit a lease
 * from wording such as "do not create an Mcode thread".
 */
export function isExplicitMcodeThreadRequest(content: string): boolean {
  const request = content.trim();
  if (!request || NEGATED_MCODE_THREAD_REQUEST.test(request)) return false;
  if (!EXPLICIT_MCODE_THREAD_TOKEN.test(request)) return false;
  return MCODE_THREAD_REQUEST_ACTION.test(request);
}

const IDENTITY_BLOCK = [
  "You are operating inside an Mcode-managed session.",
  "Mcode runtime guidance is advisory; MCP authorization and lease state remain authoritative.",
].join(" ");

const THREAD_CONTROL_BLOCK = [
  "Use the mcode MCP thread_* tools only when the user explicitly asks for Mcode threads.",
  "An Mcode thread is a persistent user-visible conversation, different from provider-native child agents.",
  "Call thread_target_list before choosing a provider or model and pass exact returned IDs.",
  "Never target the source thread.",
  "Follow each tool's description for its rules.",
].join(" ");

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
  "For visible Browser or Mcode Preview requests, use only the mcode MCP browser_* tools.",
  "Do not launch or drive another browser, profile, Playwright, generic Chrome, or Node-REPL browser.",
  "A Browser-only task needs no shell commands or local skill files.",
  "Follow each browser tool's description for readiness, targeting, acting, recovery and finishing.",
  "Finalize tabs with browser_tabs before replying.",
].join(" ");

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
