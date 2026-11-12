import type { ProviderSessionKey, ProviderSessionOccupancy, ProviderSessionOccupancyPort } from "@mcode/providers";

interface KeyRecord extends ProviderSessionOccupancy { open: boolean; epoch: number }
/** Admission-time identity, invalidated when a session closes. */
export interface UserMessageStamp { at: number; epoch: number }
/** In-memory activity authority for each provider and thread, with no timers. */
export class SessionOccupancyRegistry implements ProviderSessionOccupancyPort {
  private readonly records = new Map<string, KeyRecord>();

  constructor(private readonly deps: { now(): number }) {}

  /** Opening an already-open session preserves its epoch. */
  openSession(key: ProviderSessionKey): number {
    const id = this.id(key);
    const previous = this.records.get(id);
    if (previous?.open) return previous.epoch;
    const epoch = (previous?.epoch ?? 0) + 1;
    this.records.set(id, { open: true, epoch, held: false, lastActivityAt: null, lastUserTurnAt: null });
    return epoch;
  }

  /** An old teardown cannot close a replacement session. */
  closeSession(key: ProviderSessionKey, epoch: number): void {
    const record = this.records.get(this.id(key));
    if (record?.open && record.epoch === epoch) record.open = false;
  }

  /** Advances the idle clock monotonically. */
  touch(key: ProviderSessionKey): void {
    const record = this.records.get(this.id(key));
    if (record?.open) record.lastActivityAt = Math.max(record.lastActivityAt ?? -Infinity, this.deps.now());
  }

  /** Records changes even when no turn is open. */
  nativeChanged(key: ProviderSessionKey): void { this.touch(key); }

  /** Captures identity before an asynchronous delivery. */
  stamp(key: ProviderSessionKey): UserMessageStamp | null {
    const record = this.records.get(this.id(key));
    return record?.open ? { at: this.deps.now(), epoch: record.epoch } : null;
  }

  /** Late deliveries from retired sessions cannot extend protection. */
  userMessaged(key: ProviderSessionKey, stamp: UserMessageStamp): void {
    const record = this.records.get(this.id(key));
    if (!record?.open || record.epoch !== stamp.epoch) return;
    record.lastUserTurnAt = Math.max(record.lastUserTurnAt ?? -Infinity, stamp.at);
    this.touch(key);
  }

  /** PR 1 has no declared holds. */
  read(key: ProviderSessionKey, _now: number): ProviderSessionOccupancy {
    const record = this.records.get(this.id(key));
    return { held: false, lastActivityAt: record?.lastActivityAt ?? null, lastUserTurnAt: record?.lastUserTurnAt ?? null };
  }

  private id(key: ProviderSessionKey): string { return JSON.stringify([key.providerId, key.threadId]); }
}
