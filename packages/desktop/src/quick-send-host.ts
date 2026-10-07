import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { cursorPosition, monitorFromPoint, primaryMonitor } from '@tauri-apps/api/window';
import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import { quickSendRequestSchema } from '@dropmeme/shared';
import { applyWindowGeometry } from './monitors.js';
import { readToken, type Preferences } from './preferences.js';
import { sendText } from './send.js';

export interface QuickSendState { online: boolean; channelName?: string | undefined }
export type QuickSendResult = { id: string; ok: true } | { id: string; ok: false; error: string };
// Logical size, same as the quick-send window in tauri.conf.json.
const size = { width: 640, height: 360 };

/** Main-window side of the launcher. The quick-send webview never reads the token: it asks main to send. */
export class QuickSend {
  private online = false;
  private shortcut: string | undefined;
  private window: WebviewWindow | null = null;

  constructor(private readonly preferences: () => Preferences) {}

  async initialize(): Promise<void> {
    // A reloaded main webview would otherwise find its own previous binding already taken.
    await unregisterAll();
    this.window = await WebviewWindow.getByLabel('quick-send');
    await listen<unknown>('quick-send-request', event => { void this.relay(event.payload); }, { target: 'main' });
    await listen('quick-send-ready', () => this.push('quick-send-state'), { target: 'main' });
  }

  setOnline(online: boolean): void { this.online = online; this.push('quick-send-state'); }

  /** Registers the new shortcut before releasing the old one, so a refused change keeps the previous binding. */
  async bindShortcut(accelerator: string): Promise<void> {
    if (accelerator === this.shortcut) return;
    try { await register(accelerator, event => { if (event.state === 'Pressed') void this.open(); }); }
    catch (error) {
      throw new Error(/already registered/i.test(String(error)) ? 'Ce raccourci est déjà utilisé par une autre application. Choisissez-en un autre.' : 'Raccourci invalide. Choisissez une autre combinaison.');
    }
    if (this.shortcut) await unregister(this.shortcut).catch(() => {});
    this.shortcut = accelerator;
  }

  private push(event: 'quick-send-state' | 'quick-send-open'): void {
    if (!this.window) return;
    const state: QuickSendState = { online: this.online, channelName: this.preferences().subscription?.channelName };
    void emitTo('quick-send', event, state).catch(() => {});
  }

  private async open(): Promise<void> {
    if (!this.window) return;
    // Center on the screen under the cursor: the one the user is looking at, game or browser alike.
    const cursor = await cursorPosition();
    const monitor = await monitorFromPoint(cursor.x, cursor.y) ?? await primaryMonitor();
    if (monitor) {
      const width = Math.round(size.width * monitor.scaleFactor); const height = Math.round(size.height * monitor.scaleFactor);
      await applyWindowGeometry(this.window, {
        x: monitor.position.x + Math.round((monitor.size.width - width) / 2), y: monitor.position.y + Math.round((monitor.size.height - height) / 2), width, height,
      });
    }
    this.push('quick-send-open');
    await this.window.show(); await this.window.setFocus();
  }

  /** Payloads come from another webview: anything outside the schema is dropped unanswered. */
  private async relay(payload: unknown): Promise<void> {
    const request = quickSendRequestSchema.safeParse(payload);
    if (!request.success) return;
    const { id, text } = request.data;
    let result: QuickSendResult = { id, ok: true };
    try {
      const token = this.online ? await readToken() : undefined;
      if (!token) throw new Error('DropMeme n’est pas connecté au salon.');
      await sendText(this.preferences().server, token, text);
    } catch (error) { result = { id, ok: false, error: error instanceof Error ? error.message : 'Envoi impossible.' }; }
    await emitTo('quick-send', 'quick-send-result', result).catch(() => {});
  }
}

const modifiers = ['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS'];
/** Accelerator for the global-shortcut plugin, or undefined while only modifiers are held. */
export function shortcutFromKeyboard(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): string | undefined {
  if (modifiers.includes(event.key)) return undefined;
  // Without Ctrl, Alt or Windows the shortcut would swallow ordinary typing in every application.
  if (!event.ctrlKey && !event.altKey && !event.metaKey) throw new Error('Le raccourci doit contenir Ctrl, Alt ou Windows.');
  // Letters follow the keyboard layout (AZERTY A sits on QWERTY Q); other keys keep their physical code.
  const key = /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : event.code;
  return [event.ctrlKey && 'CommandOrControl', event.shiftKey && 'Shift', event.altKey && 'Alt', event.metaKey && 'Super', key].filter(Boolean).join('+');
}

const labels: Record<string, string> = { CommandOrControl: 'Ctrl', Shift: 'Maj', Super: 'Win', Space: 'Espace' };
export const shortcutLabel = (accelerator: string): string =>
  accelerator.split('+').map(part => labels[part] ?? part.replace(/^(Key|Digit)(?=.)/, '')).join(' + ');
