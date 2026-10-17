import {
  WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES,
  WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES,
  WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES,
  WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX,
  type WorkspaceEnvironmentAction,
  type WorkspaceEnvironmentCommand,
  type WorkspaceEnvironmentDocument,
  type WorkspaceEnvironmentValidationIssue,
  type WorkspaceEnvironmentValidationReason,
} from "@mcode/contracts";

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
  too_many_startup_actions: `At most ${WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX} actions can run on startup.`,
};

/** A validation problem tied to one action, or to the whole document when `actionId` is null. */
export interface SettingsIssue {
  readonly actionId: string | null;
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

/** Sets or clears a boolean flag, so an unchecked flag is absent from the saved file. */
export function withFlag(
  action: WorkspaceEnvironmentAction,
  flag: "runOnStartup" | "runOnCleanup",
  on: boolean,
): WorkspaceEnvironmentAction {
  const { [flag]: _previous, ...rest } = action;
  return on ? { ...rest, [flag]: true } : rest;
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

/** Local checks that mirror the server so Save can stay off without a round trip. */
export function validateDocument(document: WorkspaceEnvironmentDocument): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  for (const action of document.actions) {
    if (!commandHasScript(action.command)) {
      issues.push({ actionId: action.id, reason: "empty_script", message: REASON_COPY.empty_script ?? "" });
    }
  }
  if (document.actions.filter((action) => action.runOnStartup).length > WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX) {
    issues.push({
      actionId: null,
      reason: "too_many_startup_actions",
      message: REASON_COPY.too_many_startup_actions ?? "",
    });
  }
  return issues;
}

/** Maps a server issue's path (`["actions", index, ...]`) onto the action it names. */
export function toSettingsIssue(
  issue: WorkspaceEnvironmentValidationIssue,
  document: WorkspaceEnvironmentDocument,
): SettingsIssue {
  const [scope, index] = issue.path;
  const action = scope === "actions" && typeof index === "number" ? document.actions[index] : undefined;
  return { actionId: action?.id ?? null, reason: issue.reason, message: issueCopy(issue.reason, issue.message) };
}
