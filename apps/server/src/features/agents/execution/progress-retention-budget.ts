import type { ProgressRetentionBudget, ProgressRetentionLimits, ProgressRetentionReservation } from "./thread-progress-types.js";

/** Accounts for all unsaved progress, including writes parked after failure. */
export class BoundedProgressRetention implements ProgressRetentionBudget {
  private events = 0;
  private bytes = 0;
  private progressEvents = 0;
  private progressBytes = 0;

  constructor(private readonly limits: ProgressRetentionLimits) {
    const values = Object.values(limits);
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
      || limits.maxEvents <= limits.reservedControlEvents
      || limits.maxBytes <= limits.reservedControlBytes) {
      throw new Error("Progress retention limits must leave ordinary progress capacity");
    }
  }

  /** Reserve before accepting, leaving finite room for Stop and terminal evidence. */
  reserve(events: number, bytes: number, admission: "progress" | "control"): ProgressRetentionReservation | undefined {
    if (!Number.isSafeInteger(events) || events < 1 || !Number.isSafeInteger(bytes) || bytes < 1) {
      throw new Error("Progress retention requires positive event and byte counts");
    }
    if (!this.hasCapacity(events, bytes, admission)) return undefined;
    this.events += events;
    this.bytes += bytes;
    if (admission === "progress") {
      this.progressEvents += events;
      this.progressBytes += bytes;
    }
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.events -= events;
      this.bytes -= bytes;
      if (admission === "progress") {
        this.progressEvents -= events;
        this.progressBytes -= bytes;
      }
    } };
  }

  /** Counts omit content and can be used directly in queue telemetry. */
  depth(): { readonly events: number; readonly bytes: number } {
    return { events: this.events, bytes: this.bytes };
  }

  private hasCapacity(events: number, bytes: number, admission: "progress" | "control"): boolean {
    if (this.events + events > this.limits.maxEvents || this.bytes + bytes > this.limits.maxBytes) return false;
    return admission === "control" || this.progressEvents + events <= this.limits.maxEvents - this.limits.reservedControlEvents
      && this.progressBytes + bytes <= this.limits.maxBytes - this.limits.reservedControlBytes;
  }
}
