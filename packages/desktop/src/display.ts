import { isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import type { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, primaryMonitor } from '@tauri-apps/api/window';
import { supportsConcurrentDisplay, type MediaEvent, type Settings } from '@dropmeme/shared';
import { overlayGeometry, type DisplayRect, type ScreenRect } from './geometry.js';
import { randomGeometry } from './multi-geometry.js';
import { openOverlay } from './native-overlay.js';
import { applyWindowGeometry, monitorKey, monitorScreen, selectedMonitor } from './monitors.js';

export interface DisplayPayload { media: MediaEvent; settings: Settings; preview: boolean; box: DisplayRect }
interface Surface { label: string; ready: Promise<void>; window?: WebviewWindow; frame?: HTMLIFrameElement; failed?: boolean }
interface ActiveDisplay { surface: string; box: DisplayRect; zone?: string }

/** One transparent webview per monitor, shared by GIFs, text and one ordinary video. */
export class Display {
  private readonly surfaces = new Map<string, Surface>();
  private readonly active = new Map<string, ActiveDisplay>();
  private epoch = 0;

  async initialize(done: (id: string, error?: string) => void): Promise<void> {
    if (isTauri()) {
      await listen<{ id: string; error?: string }>('overlay-done', event => done(event.payload.id, event.payload.error), { target: 'main' });
    } else {
      window.addEventListener('message', event => {
        if (event.origin !== location.origin || ![...this.surfaces.values()].some(surface => event.source === surface.frame?.contentWindow)) return;
        const data = event.data as { type?: string; id?: string; error?: string };
        if (data?.type === 'overlay-done' && typeof data.id === 'string') done(data.id, data.error);
      });
    }
  }

  async monitors(): Promise<{ value: string; label: string }[]> {
    if (!isTauri()) return [];
    return (await availableMonitors()).map((monitor, index) => ({ value: monitorKey(monitor, index), label: `${monitor.name ?? `Écran ${index + 1}`} · ${monitor.size.width} × ${monitor.size.height}` }));
  }

  private surface(key: string): Surface {
    const existing = this.surfaces.get(key);
    if (existing) {
      if (existing.failed) { existing.failed = false; existing.ready = openOverlay(existing.label).then(window => { existing.window = window; }).catch(error => { existing.failed = true; throw error; }); }
      return existing;
    }
    if (this.surfaces.size >= 8) throw new Error('Huit écrans maximum sont pris en charge.');
    const label = this.surfaces.size ? `overlay-${this.surfaces.size}` : 'overlay';
    const surface: Surface = { label, ready: Promise.resolve() };
    this.surfaces.set(key, surface);
    if (isTauri()) {
      surface.ready = openOverlay(label).then(window => { surface.window = window; }).catch(error => { surface.failed = true; throw error; });
    } else {
      surface.ready = new Promise(resolve => {
        const frame = document.createElement('iframe'); frame.src = '/overlay.html'; frame.title = 'Aperçu du média';
        frame.style.cssText = 'position:fixed;border:0;z-index:10000;pointer-events:none;display:none;background:transparent';
        frame.onload = () => resolve(); surface.frame = frame; document.body.append(frame);
      });
    }
    return surface;
  }

  async show(media: MediaEvent, settings: Settings, preview = false): Promise<void> {
    const epoch = this.epoch;
    const parallel = settings.multiDisplay && supportsConcurrentDisplay(media);
    const used = new Set([...this.active.values()].map(value => value.zone));
    const zone = parallel && settings.multiPlacement === 'zones' ? settings.zones.find(value => !used.has(value.id)) : undefined;
    this.active.set(media.id, { surface: 'pending', box: { x: 0, y: 0, width: 0, height: 0 }, ...(zone ? { zone: zone.id } : {}) });
    const placement = zone ? { ...settings, monitor: zone.monitor, position: 'custom' as const, customX: zone.x, customY: zone.y, width: zone.width, height: zone.height } : settings;
    let key = 'primary';
    let screen: ScreenRect = { x: 0, y: 0, width: innerWidth, height: innerHeight, scale: 1 };
    if (isTauri()) {
      const monitors = await availableMonitors();
      const selected = placement.monitor === 'primary' ? await primaryMonitor() : selectedMonitor(monitors, placement.monitor);
      const monitor = selected ?? await primaryMonitor() ?? monitors[0];
      if (!monitor) throw new Error('Aucun écran disponible.');
      screen = monitorScreen(monitor);
      const index = monitors.findIndex(value => value.name === monitor.name && value.position.x === monitor.position.x && value.position.y === monitor.position.y);
      key = monitorKey(monitor, Math.max(0, index));
    }
    if (epoch !== this.epoch || !this.active.has(media.id)) return;
    const occupied = [...this.active.values()].filter(value => value.surface === key).map(value => value.box);
    const box = parallel && settings.multiPlacement === 'random' ? randomGeometry(screen, settings, occupied) : overlayGeometry(screen, placement);
    const viewport = parallel ? { x: screen.x, y: screen.y, width: screen.width, height: screen.height } : box;
    const surface = this.surface(key);
    // Reserve before loading the surface, so concurrent arrivals cannot claim the same zone.
    this.active.set(media.id, { surface: key, box, ...(zone ? { zone: zone.id } : {}) });
    try {
      await surface.ready;
      if (epoch !== this.epoch || !this.active.has(media.id)) { if (![...this.active.values()].some(value => value.surface === key)) await surface.window?.hide(); return; }
      const payload: DisplayPayload = { media, settings, preview, box: { x: (box.x - viewport.x) / screen.scale, y: (box.y - viewport.y) / screen.scale, width: box.width / screen.scale, height: box.height / screen.scale } };
      if (surface.window) {
        await applyWindowGeometry(surface.window, viewport);
        if (epoch !== this.epoch || !this.active.has(media.id)) return;
        await surface.window.show();
        if (epoch !== this.epoch || !this.active.has(media.id)) {
          if (![...this.active.values()].some(value => value.surface === key)) await surface.window.hide();
          return;
        }
        await emitTo(surface.label, 'overlay-play', payload);
      } else if (surface.frame) {
        Object.assign(surface.frame.style, { left: `${viewport.x}px`, top: `${viewport.y}px`, width: `${viewport.width}px`, height: `${viewport.height}px`, display: 'block' });
        surface.frame.contentWindow?.postMessage({ type: 'overlay-play', payload }, location.origin);
      }
    } catch (error) { this.active.delete(media.id); throw error; }
  }

  async hide(id?: string): Promise<void> {
    if (!id) this.epoch++;
    const targets = id ? [this.active.get(id)?.surface].filter((value): value is string => !!value) : [...this.surfaces.keys()];
    if (id) this.active.delete(id); else this.active.clear();
    for (const key of targets) {
      const surface = this.surfaces.get(key); if (!surface) continue;
      if (surface.window) {
        await emitTo(surface.label, 'overlay-stop', id ? { id } : {});
        if (![...this.active.values()].some(value => value.surface === key)) await surface.window.hide();
      } else if (surface.frame) {
        surface.frame.contentWindow?.postMessage({ type: 'overlay-stop', payload: id ? { id } : {} }, location.origin);
        if (![...this.active.values()].some(value => value.surface === key)) surface.frame.style.display = 'none';
      }
    }
  }

  async updateSettings(settings: Settings): Promise<void> {
    for (const surface of this.surfaces.values()) {
      if (surface.window) await emitTo(surface.label, 'overlay-settings', settings);
      else surface.frame?.contentWindow?.postMessage({ type: 'overlay-settings', payload: settings }, location.origin);
    }
  }
}
