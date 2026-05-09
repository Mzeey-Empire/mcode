// Logging
export { logger, getLogPath, getRecentLogs } from "./logging/index.js";

// Paths
export {
  getMcodeDir,
  isLinkedGitWorktree,
  resolveDbPath,
} from "./paths/index.js";

// Git utilities
export {
  validateWorktreeName,
  validateBranchName,
  sanitizeBranchForFolder,
} from "./git/index.js";

// Model effort normalization
export {
  isXhighEffortModel,
  isMaxEffortModel,
  supportsEffortParameter,
  supportsUltrathink,
  supports1MContextWindow,
  supportsThinkingToggle,
  normalizeReasoningLevelForModel,
} from "./model-effort/index.js";

export { redactMcodeBrowserCaptureV2 } from "./browser-preview/redact.js";
