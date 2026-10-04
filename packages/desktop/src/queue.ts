import type { MediaEvent, Settings } from '@dropmeme/shared';

/** FIFO with bounded memory. Pause discards incoming media rather than replaying a flood. */
export class MediaQueue {
  private pending: MediaEvent[] = [];
  private active: MediaEvent | undefined;
  private seen = new Set<string>();
  private paused = false;

  constructor(private settings: Settings, private readonly display: (media: MediaEvent) => void, private readonly changed: (pending: number, active: boolean) => void = () => {}) {}

  configure(settings: Settings): void {
    this.settings = settings;
    this.pending = this.pending.filter(media => this.accepts(media)).slice(0, settings.maxQueue);
    this.notify();
  }

  private accepts(media: MediaEvent): boolean {
    return media.kind === 'image' ? this.settings.images : media.kind === 'video' ? this.settings.videos : this.settings.audio && this.settings.sound;
  }

  enqueue(media: MediaEvent): boolean {
    if (this.paused || this.seen.has(media.id) || !this.accepts(media) || this.pending.length >= this.settings.maxQueue || Date.now() - media.createdAt > 5 * 60_000) return false;
    this.seen.add(media.id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    this.pending.push(media);
    this.next(); return true;
  }

  complete(id: string): void {
    if (this.active?.id !== id) return;
    this.active = undefined; this.next();
  }

  clear(): void { this.pending = []; this.active = undefined; this.notify(); }
  reset(): void { this.clear(); this.seen.clear(); }
  setPaused(value: boolean): void { this.paused = value; if (value) this.clear(); else this.next(); }
  currentId(): string | undefined { return this.active?.id; }

  private next(): void {
    if (!this.paused && !this.active) {
      do { this.active = this.pending.shift(); }
      while (this.active && Date.now() - this.active.createdAt > 5 * 60_000);
      if (this.active) this.display(this.active);
    }
    this.notify();
  }
  private notify(): void { this.changed(this.pending.length, !!this.active); }
}
