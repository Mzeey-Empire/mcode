import { WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES, WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES, WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES, WorkspaceEnvironmentActionSchema, WorkspaceEnvironmentDocumentSchema, workspaceEnvironmentValidationIssues, type WorkspaceEnvironmentAction, type WorkspaceEnvironmentCommand, type WorkspaceEnvironmentDocument, type WorkspaceEnvironmentValidationIssue, type WorkspaceEnvironmentValidationReason } from "@mcode/contracts/models/workspace-environment";

/** The platform tabs of an action's command editor. `default` runs wherever no override matches. */
export type CommandPlatform = keyof WorkspaceEnvironmentCommand;

/** Platform tabs in display order, with the label the editor shows. */
export const COMMAND_PLATFORMS: readonly { readonly value: CommandPlatform; readonly label: string }[] = [
  { value: "default", label: "All" },
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "windows", label: "Windows" },
];

/** The document the editor shows before a Project has a saved one. */
export const EMPTY_DOCUMENT: WorkspaceEnvironmentDocument = { version: "0.0.1", actions: [] };

const kilobytes = (bytes: number) => `${bytes / 1024} KB`;

/** Copy for each server validation reason the editor can explain next to the field that caused it. */
const REASON_COPY: Partial<Record<WorkspaceEnvironmentValidationReason, string>> = {
  empty_script: "Add a command to save this action.",
  script_too_large: `This command is too long. The limit is ${kilobytes(WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES)}.`,
  command_too_large: `These commands are too long together. The limit is ${kilobytes(WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES)}.`,
  document_too_large: `Too many actions to save. The limit is ${kilobytes(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES)}.`,
  null_byte: "Commands can't contain null characters.",
};

/** The editor field an action issue sits under. */
export type SettingsIssueField = "command" | "openPreview";

/** A validation problem tied to one action's field, or to the whole document when `actionId` is null. */
export interface SettingsIssue {
  readonly actionId: string | null;
  readonly field: SettingsIssueField;
  readonly reason: WorkspaceEnvironmentValidationReason;
  readonly message: string;
}

/** The copy the editor shows for a reason, falling back to the server's message. */
export function issueCopy(reason: WorkspaceEnvironmentValidationReason, serverMessage: string): string {
  return REASON_COPY[reason] ?? serverMessage;
}

/** The script an action runs when no platform override applies, used for its icon and preview. */
export function scriptOf(command: WorkspaceEnvironmentCommand): string {
  return command.default ?? command.windows ?? command.macos ?? command.linux ?? "";
}

/** Whether any platform of the command has a non-blank script, mirroring the server's `empty_script` check. */
export function commandHasScript(command: WorkspaceEnvironmentCommand): boolean {
  return Object.values(command).some((script) => typeof script === "string" && script.trim().length > 0);
}

/** Whether a platform tab carries an override that differs from the shared default. */
export function platformHasScript(command: WorkspaceEnvironmentCommand, platform: CommandPlatform): boolean {
  const script = command[platform];
  return typeof script === "string" && script.length > 0;
}

/** Sets one platform's script, removing the key when it is emptied so the saved file stays minimal. */
export function withPlatformScript(
  command: WorkspaceEnvironmentCommand,
  platform: CommandPlatform,
  script: string,
): WorkspaceEnvironmentCommand {
  const { [platform]: _previous, ...rest } = command;
  return script.length === 0 ? rest : { ...rest, [platform]: script };
}

/** Action keys the editor shows as switches: every schema key except identity, command and icon. */
export type ActionOptionKey = Exclude<
  keyof ReturnType<typeof WorkspaceEnvironmentActionSchema>["shape"],
  "id" | "name" | "command" | "icon"
>;

/** How one option renders: its switch row and, when set, the chip on the collapsed action row. */
export interface ActionOptionRow {
  readonly label: string;
  /** Muted second line, omitted for rows whose label already says enough. */
  readonly hint: string | null;
  /** The option this one is inert without. Turning the parent off clears it. */
  readonly dependsOn: ActionOptionKey | null;
  readonly chip: string | null;
}

/** Every action option in display order. A new schema key without a row here fails typecheck. */
export const ACTION_OPTIONS = {
  runOnStartup: { label: "Run on startup", hint: "When a thread starts in a worktree", dependsOn: null, chip: "On startup" },
  waitForExit: { label: "Wait for it to finish before the agent starts", hint: null, dependsOn: "runOnStartup", chip: null },
  runOnSettle: { label: "Run when the thread settles", hint: null, dependsOn: null, chip: "On settle" },
  runOnCleanup: { label: "Run on cleanup", hint: "Before the worktree is removed", dependsOn: null, chip: "On cleanup" },
  openPreview: { label: "Open preview automatically when this action runs", hint: null, dependsOn: null, chip: null },
} as const satisfies Record<ActionOptionKey, ActionOptionRow>;

/** Option keys in display order, derived from the table so the two cannot drift. */
export const ACTION_OPTION_KEYS = Object.keys(ACTION_OPTIONS) as readonly ActionOptionKey[];

/** Whether an option's switch reads as on. `waitForExit` is on unless explicitly `false`. */
export function readOption(action: WorkspaceEnvironmentAction, key: ActionOptionKey): boolean {
  if (key === "waitForExit") return action.waitForExit !== false;
  if (key === "openPreview") return action.openPreview !== undefined;
  return action[key] === true;
}

function withoutKey(action: WorkspaceEnvironmentAction, key: ActionOptionKey): WorkspaceEnvironmentAction {
  const { [key]: _previous, ...rest } = action;
  return rest;
}

function dependentsOf(key: ActionOptionKey): ActionOptionKey[] {
  return ACTION_OPTION_KEYS.filter((other) => ACTION_OPTIONS[other].dependsOn === key);
}

/**
 * Sets one option so a default value is absent from the saved file, and clears dependents when
 * their parent turns off so no inert key is left behind.
 */
export function withOption(action: WorkspaceEnvironmentAction, key: ActionOptionKey, on: boolean): WorkspaceEnvironmentAction {
  const rest = withoutKey(action, key);
  if (key === "waitForExit") return on ? rest : { ...rest, waitForExit: false };
  if (!on) return dependentsOf(key).reduce(withoutKey, rest);
  return key === "openPreview" ? { ...rest, openPreview: true } : { ...rest, [key]: true };
}

/** Sets the preview URL. A blank URL means "open the first URL the action prints". */
export function withPreviewUrl(action: WorkspaceEnvironmentAction, url: string): WorkspaceEnvironmentAction {
  return { ...action, openPreview: url.trim().length === 0 ? true : url };
}

/** Why an option is unavailable, such as "Requires Run on startup", or null when it can be changed. */
export function optionDisabledReason(action: WorkspaceEnvironmentAction, key: ActionOptionKey): string | null {
  const parent = ACTION_OPTIONS[key].dependsOn;
  return parent && !readOption(action, parent) ? `Requires ${ACTION_OPTIONS[parent].label}` : null;
}

/** Chips for the collapsed row, one per option that is on and has a chip. */
export function optionChips(action: WorkspaceEnvironmentAction): string[] {
  return ACTION_OPTION_KEYS.flatMap((key) => {
    const chip = ACTION_OPTIONS[key].chip;
    return chip && readOption(action, key) && !optionDisabledReason(action, key) ? [chip] : [];
  });
}

/** A new action that is waiting for its command. */
export function newAction(): WorkspaceEnvironmentAction {
  return { id: crypto.randomUUID(), name: "action", command: { default: "" } };
}

/** A copy of `action` under a new id, so both can be saved side by side. */
export function duplicateAction(action: WorkspaceEnvironmentAction): WorkspaceEnvironmentAction {
  return { ...action, id: crypto.randomUUID(), name: `${action.name} copy` };
}

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
}

function recordsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key], b[key]));
}

/** Key-order independent structural equality for JSON documents, so a reordered file is not "dirty". */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && arraysEqual(a, b);
  return recordsEqual(a as Record<string, unknown>, b as Record<string, unknown>);
}

function fieldOf(path: readonly (string | number)[]): SettingsIssueField {
  return path[2] === "openPreview" ? "openPreview" : "command";
}

/** Whether the contract schema owns this check's copy, so the editor does not restate it. */
function isSchemaOwnedIssue(issue: WorkspaceEnvironmentValidationIssue): boolean {
  return issue.reason === "too_many_startup_actions" || fieldOf(issue.path) === "openPreview";
}

/** Local checks that mirror the server so Save can stay off without a round trip. */
export function validateDocument(document: WorkspaceEnvironmentDocument): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  for (const action of document.actions) {
    if (!commandHasScript(action.command)) {
      issues.push({ actionId: action.id, field: "command", reason: "empty_script", message: REASON_COPY.empty_script ?? "" });
    }
  }
  const parsed = WorkspaceEnvironmentDocumentSchema().safeParse(document);
  if (!parsed.success) {
    for (const issue of workspaceEnvironmentValidationIssues(parsed.error)) {
      if (isSchemaOwnedIssue(issue)) issues.push(toSettingsIssue(issue, document));
    }
  }
  return issues;
}

/** Maps a server issue's path (`["actions", index, field, ...]`) onto the action and field it names. */
export function toSettingsIssue(
  issue: WorkspaceEnvironmentValidationIssue,
  document: WorkspaceEnvironmentDocument,
): SettingsIssue {
  const [scope, index] = issue.path;
  const action = scope === "actions" && typeof index === "number" ? document.actions[index] : undefined;
  return {
    actionId: action?.id ?? null,
    field: fieldOf(issue.path),
    reason: issue.reason,
    message: issueCopy(issue.reason, issue.message),
  };
}
