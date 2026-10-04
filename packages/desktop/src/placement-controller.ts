import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, primaryMonitor } from '@tauri-apps/api/window';
import type { Settings } from '@dropmeme/shared';
import { overlayGeometry, placementSettings, screenForBox, type DisplayRect, type ScreenRect } from './geometry.js';
import { applyWindowGeometry, monitorKey, monitorScreen, selectedMonitor } from './monitors.js';

/** Editing gets its own interactive webview. The player stays unfocusable and click-through. */
export async function placeOverlay(settings: Settings): Promise<Settings | undefined> {
  return isTauri() ? placeNative(settings) : placeBrowser(settings);
}

async function placeNative(settings: Settings): Promise<Settings | undefined> {
  let finish!: (save: boolean) => void;
  const completed = new Promise<boolean>(resolve => { finish = resolve; });
  const unlisten = await listen<{ save: boolean }>('placement-complete', event => finish(event.payload.save === true));
  let window: WebviewWindow | null = null;
  let unclose: (() => void) | undefined;
  try {
    await invoke('create_placement');
    window = await WebviewWindow.getByLabel('placement');
    if (!window) throw new Error('Cadre de placement introuvable.');
    const monitors = await availableMonitors();
    const selected = settings.monitor === 'primary' ? await primaryMonitor() : selectedMonitor(monitors, settings.monitor);
    const monitor = selected ?? await primaryMonitor() ?? monitors[0];
    if (!monitor) throw new Error('Aucun écran disponible.');
    const box = overlayGeometry(monitorScreen(monitor), settings);
    await applyWindowGeometry(window, box);
    unclose = await window.onCloseRequested(event => { event.preventDefault(); finish(false); });
    await window.show(); await window.setFocus();
    if (!await completed) return undefined;
    const position = await window.outerPosition(); const size = await window.innerSize();
    const bounds = { x: position.x, y: position.y, width: size.width, height: size.height };
    const current = await availableMonitors();
    if (!current.length) throw new Error('Aucun écran disponible.');
    const index = screenForBox(current.map(monitorScreen), bounds);
    return placementSettings(monitorScreen(current[index]!), bounds, settings, monitorKey(current[index]!, index));
  } finally {
    unlisten(); unclose?.();
    // The editing webview is transient: do not retain an extra renderer during normal playback.
    await window?.destroy();
  }
}

function placeBrowser(settings: Settings): Promise<Settings | undefined> {
  const screen: ScreenRect = { x: 0, y: 0, width: innerWidth, height: innerHeight, scale: 1 };
  let box = overlayGeometry(screen, settings); let start: DisplayRect = box;
  const frame = document.createElement('iframe'); frame.src = '/placement.html'; frame.title = 'Placer la zone';
  frame.style.cssText = 'position:fixed;border:0;z-index:10001;background:transparent';
  const render = () => Object.assign(frame.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
  render(); document.body.append(frame);
  return new Promise(resolve => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: string; payload?: { save?: boolean; kind?: string; start?: boolean; dx?: number; dy?: number } };
      const payload = data?.payload;
      if (data?.type === 'placement-complete') {
        window.removeEventListener('message', handler); frame.remove();
        resolve(payload?.save === true ? placementSettings(screen, box, settings, 'primary') : undefined);
      } else if (data?.type === 'placement-gesture' && payload) {
        if (payload.start) start = { ...box };
        if (!Number.isFinite(payload.dx) || !Number.isFinite(payload.dy)) return;
        if (payload.kind === 'move') box = { ...start, x: Math.min(screen.width - box.width, Math.max(0, start.x + payload.dx!)), y: Math.min(screen.height - box.height, Math.max(0, start.y + payload.dy!)) };
        else if (payload.kind === 'resize') box = { ...start, width: Math.max(160, Math.min(screen.width - start.x, start.width + payload.dx!)), height: Math.max(120, Math.min(screen.height - start.y, start.height + payload.dy!)) };
        render();
      }
    };
    window.addEventListener('message', handler);
  });
}
