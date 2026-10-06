import { isAnimation, type MediaEvent, type Settings } from '@dropmeme/shared';

/** FIFO with bounded memory. Pause discards incoming media rather than replaying a flood. */
export class MediaQueue {
  private pending: MediaEvent[] = [];
  private active = new Map<string, MediaEvent>();
  private seen = new Set<string>();
  private paused = false;

  constructor(private settings: Settings, private readonly display: (media: MediaEvent) => void, private readonly changed: (pending: number, active: boolean, count: number) => void = () => {}) {}

  configure(settings: Settings): void {
    this.settings = settings;
    this.pending = this.pending.filter(media => this.accepts(media)).slice(0, settings.maxQueue);
    this.next();
  }

  private accepts(media: MediaEvent): boolean {
    return media.kind === 'text' ? this.settings.texts : media.kind === 'image' || (media.kind === 'video' && media.loop === true) ? this.settings.images : media.kind === 'video' ? this.settings.videos : this.settings.audio && this.settings.sound;
  }

  enqueue(media: MediaEvent): boolean {
    if (this.paused || this.seen.has(media.id) || !this.accepts(media) || this.pending.length >= this.settings.maxQueue || Date.now() - media.createdAt > 5 * 60_000) return false;
    this.seen.add(media.id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    this.pending.push(media);
    this.next(); return true;
  }

  complete(id: string): void {
    if (!this.active.delete(id)) return;
    this.next();
  }

  /** Drops deleted media for good. Returns those on screen: hide them, then complete(). */
  retract(ids: readonly string[]): string[] {
    for (const id of ids) this.seen.add(id);
    while (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    this.pending = this.pending.filter(media => !ids.includes(media.id));
    this.notify();
    return ids.filter(id => this.active.has(id));
  }

  clear(): void { this.pending = []; this.active.clear(); this.notify(); }
  reset(): void { this.clear(); this.seen.clear(); }
  setPaused(value: boolean): void { this.paused = value; if (value) this.clear(); else this.next(); }
  currentId(): string | undefined { return this.active.keys().next().value; }
  currentIds(): string[] { return [...this.active.keys()]; }
  has(id: string): boolean { return this.active.has(id); }

  private canStart(media: MediaEvent): boolean {
    if (!this.active.size) return true;
    const limit = this.settings.multiPlacement === 'zones' ? Math.min(this.settings.maxSimultaneous, Math.max(1, this.settings.zones.length)) : this.settings.maxSimultaneous;
    return this.settings.multiDisplay && isAnimation(media) && [...this.active.values()].every(isAnimation) && this.active.size < limit;
  }

  private next(): void {
    while (!this.paused && this.pending.length) {
      const media = this.pending[0]!;
      if (Date.now() - media.createdAt > 5 * 60_000) { this.pending.shift(); continue; }
      if (!this.canStart(media)) break;
      this.pending.shift(); this.active.set(media.id, media); this.display(media);
    }
    this.notify();
  }
  private notify(): void { this.changed(this.pending.length, this.active.size > 0, this.active.size); }
}
