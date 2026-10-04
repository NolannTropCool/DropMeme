import { isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, primaryMonitor } from '@tauri-apps/api/window';
import type { MediaEvent, Settings } from '@dropmeme/shared';
import { overlayGeometry } from './geometry.js';
import { openOverlay } from './native-overlay.js';
import { applyWindowGeometry, monitorKey, monitorScreen, selectedMonitor } from './monitors.js';

export interface DisplayPayload { media: MediaEvent; settings: Settings; preview: boolean }
export class Display {
  private window: WebviewWindow | undefined;
  private iframe: HTMLIFrameElement | undefined;
  private ready: Promise<void> | undefined;
  private serial = 0;

  async initialize(done: (id: string, error?: string) => void): Promise<void> {
    if (isTauri()) {
      await listen<{ id: string; error?: string }>('overlay-done', event => done(event.payload.id, event.payload.error));
    } else {
      window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.source !== this.iframe?.contentWindow) return;
        const data = event.data as { type?: string; id?: string; error?: string };
        if (data?.type === 'overlay-done' && typeof data.id === 'string') done(data.id, data.error);
      });
    }
  }

  async monitors(): Promise<{ value: string; label: string }[]> {
    if (!isTauri()) return [];
    return (await availableMonitors()).map((monitor, index) => ({ value: monitorKey(monitor, index), label: `${monitor.name ?? `Écran ${index + 1}`} · ${monitor.size.width} × ${monitor.size.height}` }));
  }

  private async ensureWindow(): Promise<void> {
    if (this.ready) return this.ready;
    if (!isTauri()) {
      this.ready = new Promise(resolve => {
        const frame = document.createElement('iframe');
        frame.src = '/overlay.html'; frame.title = 'Aperçu du média';
        frame.style.cssText = 'position:fixed;border:0;z-index:10000;pointer-events:none;display:none;background:transparent';
        frame.onload = () => resolve(); this.iframe = frame; document.body.append(frame);
      });
    } else {
      this.ready = openOverlay().then(window => { this.window = window; }).catch(error => { this.ready = undefined; throw error; });
    }
    return this.ready;
  }

  async show(media: MediaEvent, settings: Settings, preview = false): Promise<void> {
    const serial = ++this.serial;
    await this.ensureWindow();
    if (serial !== this.serial) return;
    const payload: DisplayPayload = { media, settings, preview };
    if (isTauri() && this.window) {
      const monitors = await availableMonitors();
      const selected = settings.monitor === 'primary' ? await primaryMonitor() : selectedMonitor(monitors, settings.monitor);
      const monitor = selected ?? await primaryMonitor() ?? monitors[0];
      if (!monitor) throw new Error('Aucun écran disponible.');
      const box = overlayGeometry(monitorScreen(monitor), settings);
      await applyWindowGeometry(this.window, box);
      await this.window.setIgnoreCursorEvents(true);
      if (serial !== this.serial) return;
      await emitTo('overlay', 'overlay-play', payload);
      await this.window.show();
    } else if (this.iframe) {
      const box = overlayGeometry({ x: 0, y: 0, width: innerWidth, height: innerHeight, scale: 1 }, settings);
      Object.assign(this.iframe.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, display: 'block' });
      this.iframe.contentWindow?.postMessage({ type: 'overlay-play', payload }, location.origin);
    }
  }

  async hide(): Promise<void> {
    ++this.serial;
    if (isTauri() && this.window) {
      await emitTo('overlay', 'overlay-stop'); await this.window.hide();
    } else if (this.iframe) {
      this.iframe.contentWindow?.postMessage({ type: 'overlay-stop' }, location.origin);
      this.iframe.style.display = 'none';
    }
  }
}
