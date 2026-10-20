/** Routes browser automation operations to visible renderer hosts. */
export {
  BrowserAutomationBroker,
  type BrowserAutomationHostConnectionAuthorization,
} from "./execution/broker.js";

/** Stores and revokes browser automation credentials. */
export {
  BrowserAutomationCredentialRegistry,
  type BrowserAutomationCredentialClaims,
} from "./access/credential-registry.js";

/** Maps provider permission settings to browser automation capability. */
export {
  browserAutomationPermissionCapability,
  type BrowserAutomationCredentialMetadata,
} from "./access/access-service.js";

/** Coordinates provider browser automation session leases. */
export {
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseGrant,
  type BrowserAutomationSessionLeaseScope,
  type BrowserAutomationSessionLeaseStage,
} from "./access/browser-automation-session-lease.js";

/** Records bounded browser automation lifecycle telemetry. */
export { BrowserAutomationTelemetry } from "./observability/telemetry.js";

/** Projects Browser provider events into content-free narrative events. */
export { BrowserNarrativeEventSanitizer } from "./observability/browser-narrative-event-sanitizer.js";
