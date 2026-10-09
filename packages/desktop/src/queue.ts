import { isAnimation, supportsConcurrentDisplay, type MediaEvent, type Settings } from '@dropmeme/shared';

const ordinaryVideo = (media: MediaEvent): boolean => media.kind === 'video' && !isAnimation(media);

/** Bounded queue with FIFO videos. Pause discards incoming media instead of replaying a flood. */
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

  clear(): void { this.pending = []; this.active.clear(); this.notify(); }
  reset(): void { this.clear(); this.seen.clear(); }
  setPaused(value: boolean): void { this.paused = value; if (value) this.clear(); else this.next(); }
  currentId(): string | undefined { return this.active.keys().next().value; }
  currentIds(): string[] { return [...this.active.keys()]; }
  has(id: string): boolean { return this.active.has(id); }

  private canStart(media: MediaEvent): boolean {
    if (!this.active.size) return true;
    const limit = this.settings.multiPlacement === 'zones' ? Math.min(this.settings.maxSimultaneous, Math.max(1, this.settings.zones.length)) : this.settings.maxSimultaneous;
    const active = [...this.active.values()];
    return this.settings.multiDisplay && supportsConcurrentDisplay(media) && active.every(supportsConcurrentDisplay) && this.active.size < limit
      && (!ordinaryVideo(media) || !active.some(ordinaryVideo));
  }

  private next(): void {
    while (!this.paused && this.pending.length) {
      this.pending = this.pending.filter(media => Date.now() - media.createdAt <= 5 * 60_000);
      // A waiting second video must not hold up later GIFs/text. Keep video order and
      // retain FIFO barriers for formats that cannot share the overlay (static images/audio).
      const index = this.settings.multiDisplay && [...this.active.values()].some(ordinaryVideo)
        ? this.pending.findIndex(media => !ordinaryVideo(media)) : 0;
      const media = this.pending[index];
      if (!media || !this.canStart(media)) break;
      this.pending.splice(index, 1); this.active.set(media.id, media); this.display(media);
    }
    this.notify();
  }
  private notify(): void { this.changed(this.pending.length, this.active.size > 0, this.active.size); }
}
