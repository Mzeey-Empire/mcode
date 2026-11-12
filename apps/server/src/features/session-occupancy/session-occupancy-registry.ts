import type { ProviderSessionKey, ProviderSessionOccupancy, ProviderSessionOccupancyPort } from "@mcode/providers";

interface OpenRecord extends ProviderSessionOccupancy { epoch: number }
/** Admission-time identity, invalidated when a session closes. */
export interface UserMessageStamp { at: number; epoch: number }
/** In-memory activity authority for each open provider session, with no timers. */
export class SessionOccupancyRegistry implements ProviderSessionOccupancyPort {
  private readonly records = new Map<string, OpenRecord>();
  // One counter for every key keeps epochs unique after a closed record is deleted.
  private lastEpoch = 0;

  constructor(private readonly deps: { now(): number }) {}

  /** Opening an already-open session preserves its epoch. */
  openSession(key: ProviderSessionKey): number {
    const id = this.id(key);
    const open = this.records.get(id);
    if (open) return open.epoch;
    const epoch = ++this.lastEpoch;
    this.records.set(id, { epoch, held: false, lastActivityAt: null, lastUserTurnAt: null });
    return epoch;
  }

  /** An old teardown cannot close a replacement session. */
  closeSession(key: ProviderSessionKey, epoch: number): void {
    const id = this.id(key);
    if (this.records.get(id)?.epoch === epoch) this.records.delete(id);
  }

  /** Advances the idle clock monotonically. */
  touch(key: ProviderSessionKey): void {
    const record = this.records.get(this.id(key));
    if (record) record.lastActivityAt = Math.max(record.lastActivityAt ?? -Infinity, this.deps.now());
  }

  /** Records changes even when no turn is open. */
  nativeChanged(key: ProviderSessionKey): void { this.touch(key); }

  /** Captures identity before an asynchronous delivery. */
  stamp(key: ProviderSessionKey): UserMessageStamp | null {
    const record = this.records.get(this.id(key));
    return record ? { at: this.deps.now(), epoch: record.epoch } : null;
  }

  /** Late deliveries from retired sessions cannot extend protection. */
  userMessaged(key: ProviderSessionKey, stamp: UserMessageStamp): void {
    const record = this.records.get(this.id(key));
    if (record?.epoch !== stamp.epoch) return;
    record.lastUserTurnAt = Math.max(record.lastUserTurnAt ?? -Infinity, stamp.at);
    this.touch(key);
  }

  /** No caller can declare a hold yet, so `held` is always false. */
  read(key: ProviderSessionKey, _now: number): ProviderSessionOccupancy {
    const record = this.records.get(this.id(key));
    return { held: false, lastActivityAt: record?.lastActivityAt ?? null, lastUserTurnAt: record?.lastUserTurnAt ?? null };
  }

  private id(key: ProviderSessionKey): string { return JSON.stringify([key.providerId, key.threadId]); }
}
