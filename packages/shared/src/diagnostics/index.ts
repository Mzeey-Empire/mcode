export { diag, DiagRecorder } from "./recorder.js";
export type { DiagConfiguration } from "./recorder.js";
export { DIAG_CATALOG, event, span } from "./catalog.js";
export type {
  BeginPayload,
  DiagChannelName,
  EndPayload,
  EventName,
  EventPayload,
  IdsOf,
  SpanName,
} from "./catalog.js";
export { parseAppendHeader, parseDiagLine } from "./record.js";
export type { AppendHeader, DiagIds, DiagOutcome, DiagRecord } from "./record.js";
export { redactDiagnostic } from "./internal/bound.js";
export { recordingFileId } from "./internal/sink.js";
