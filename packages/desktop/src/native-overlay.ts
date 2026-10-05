import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

/** Handshake is repeatable: a surviving webview must also answer after a failed first attempt. */
export async function openOverlay(label = 'overlay'): Promise<WebviewWindow> {
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const unlisten = await listen<{ label: string }>('overlay-ready', event => { if (event.payload.label === label) resolveReady(); }, { target: 'main' });
  let probe: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  try {
    return await Promise.race([
      (async () => {
        await invoke('create_overlay', { label });
        if (!active) throw new Error('Ouverture annulée.');
        const window = await WebviewWindow.getByLabel(label);
        if (!window) throw new Error('Superposition introuvable.');
        await window.setIgnoreCursorEvents(true);
        // WebView2 must not be waiting for visibility while we wait for its JavaScript.
        // The empty transparent window is click-through and never takes focus.
        await window.show();
        if (!active) throw new Error('Ouverture annulée.');
        const ping = () => { void emitTo(label, 'overlay-probe').catch(() => {}); };
        ping(); probe = setInterval(ping, 250);
        await ready;
        return window;
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('La superposition ne répond pas. Redémarrez DropMeme et vérifiez WebView2.')), 10_000);
      }),
    ]);
  } finally { active = false; clearTimeout(timeout); clearInterval(probe); unlisten(); }
}
