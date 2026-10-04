import { isTauri, invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, primaryMonitor } from '@tauri-apps/api/window';
import type { MediaEvent, Settings } from '@dropmeme/shared';
import { overlayGeometry } from './geometry.js';

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
    return (await availableMonitors()).map((monitor, index) => ({ value: String(index), label: monitor.name ?? `Écran ${index + 1}` }));
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
      this.ready = (async () => {
        let loaded!: () => void;
        const loading = new Promise<void>(resolve => { loaded = resolve; });
        const unlisten = await listen('overlay-ready', loaded);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await invoke('create_overlay');
          this.window = (await WebviewWindow.getByLabel('overlay')) ?? undefined;
          if (!this.window) throw new Error('Superposition introuvable.');
          await Promise.race([loading, new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('La superposition ne répond pas.')), 10_000);
          })]);
        } finally { clearTimeout(timeout); unlisten(); }
      })().catch(error => { this.ready = undefined; throw error; });
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
      const selected = settings.monitor === 'primary' ? await primaryMonitor() : monitors[Number(settings.monitor)];
      const monitor = selected ?? await primaryMonitor() ?? monitors[0];
      if (!monitor) throw new Error('Aucun écran disponible.');
      const box = overlayGeometry({ x: monitor.position.x, y: monitor.position.y, width: monitor.size.width, height: monitor.size.height, scale: monitor.scaleFactor }, settings);
      await this.window.setSize(new PhysicalSize(box.width, box.height));
      await this.window.setPosition(new PhysicalPosition(box.x, box.y));
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
