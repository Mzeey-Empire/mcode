import type { WorkspaceEnvironmentValidationIssue } from "@mcode/contracts/models/workspace-environment";

/** Structured lifecycle error returned by the workspace environment boundary. */
export class WorkspaceEnvironmentServiceError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_ENVIRONMENT_VALIDATION"
      | "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION"
      | "WORKSPACE_ENVIRONMENT_STALE"
      | "WORKSPACE_ENVIRONMENT_NOT_FOUND"
      | "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY"
      | "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE"
      | "WORKSPACE_ENVIRONMENT_ACTION_RUNNING"
      | "WORKSPACE_ENVIRONMENT_TERMINAL_CAP"
      | "WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND"
      | "WORKSPACE_ENVIRONMENT_APPROVAL_STALE"
      | "WORKSPACE_ENVIRONMENT_APPROVAL_NOT_REQUIRED"
      | "WORKSPACE_ENVIRONMENT_RUN_CLOSED",
    message: string,
    readonly issues?: readonly WorkspaceEnvironmentValidationIssue[],
  ) {
    super(message);
    this.name = "WorkspaceEnvironmentServiceError";
  }
}
