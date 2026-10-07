import { Channel, invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { cursorPosition, monitorFromPoint, primaryMonitor } from '@tauri-apps/api/window';
import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import { quickSendRequestSchema, type Favorite, type GifSearchResponse } from '@dropmeme/shared';
import type { Favorites, ReceivedMedia } from './favorites.js';
import { applyWindowGeometry } from './monitors.js';
import { readToken, type Preferences } from './preferences.js';
import { defaultMaxMediaBytes, fileError } from './picker.js';
import { searchGifs, sendFile, sendGif, sendText } from './send.js';

export interface QuickSendState { online: boolean; channelName?: string | undefined; gifSearch: boolean; maxMediaBytes: number; favorites: Favorite[]; received: ReceivedMedia[] }
type ServerFeatures = { gifSearch?: boolean | undefined; maxMediaBytes?: number | undefined };
export type QuickSendResult = { id: string; ok: true; gifs?: GifSearchResponse } | { id: string; ok: false; error: string };
// Logical size, same as the quick-send window in tauri.conf.json.
const size = { width: 640, height: 440 };

/** Main-window side of the launcher. The quick-send webview never reads the token: it asks main to send or search. */
export class QuickSend {
  private online = false;
  private features: ServerFeatures = {};
  private search: AbortController | undefined;
  private shortcut: string | undefined;
  private window: WebviewWindow | null = null;

  constructor(private readonly preferences: () => Preferences, private readonly favorites: Favorites) {}

  async initialize(): Promise<void> {
    // A reloaded main webview would otherwise find its own previous binding already taken.
    await unregisterAll();
    this.window = await WebviewWindow.getByLabel('quick-send');
    // Requests arrive only through Rust, which checks they come from the quick-send webview.
    const relay = new Channel<unknown>(); relay.onmessage = payload => { void this.relay(payload); };
    await invoke('quick_send_listen', { channel: relay });
  }

  /** Features come from the server's ready event; a 0.2 server omits them. */
  setOnline(online: boolean, features: ServerFeatures = {}): void { this.online = online; this.features = online ? features : {}; this.push('quick-send-state'); }
  private get maxMediaBytes(): number { return this.features.maxMediaBytes ?? defaultMaxMediaBytes; }

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

  /** Also called when the favorites change: main holds them, quick-send only receives this state. */
  push(event: 'quick-send-state' | 'quick-send-open' = 'quick-send-state'): void {
    if (!this.window) return;
    const state: QuickSendState = {
      online: this.online, channelName: this.preferences().subscription?.channelName, gifSearch: !!this.features.gifSearch, maxMediaBytes: this.maxMediaBytes,
      favorites: this.favorites.list, received: this.favorites.received,
    };
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
    const data = request.data; const { id } = data;
    // A newer search supersedes the previous one: its late answer would overwrite fresher results.
    const search = data.kind === 'search' ? (this.search?.abort(), this.search = new AbortController()) : undefined;
    let result: QuickSendResult = { id, ok: true };
    try {
      // Favorites stay on the device: no token, and a received media is downloaded through main's own ticket.
      if (data.kind === 'favorite-gif') await this.favorites.addGif(data.gif, data.name);
      else if (data.kind === 'favorite-file') await this.favorites.addFile(await invoke<ArrayBuffer>('take_file', { id }), data.type, data.name);
      else if (data.kind === 'favorite-received') await this.favorites.addReceived(data.media);
      else {
        // Claim the staged bytes first so Rust frees them even when this send fails.
        const file = data.kind === 'file' ? new File([await invoke<ArrayBuffer>('take_file', { id })], data.name, { type: data.type }) : undefined;
        const invalid = file && fileError(file, this.maxMediaBytes);
        if (invalid) throw new Error(invalid);
        const token = this.online ? await readToken() : undefined;
        if (!token) throw new Error('DropMeme n’est pas connecté au salon.');
        const { server } = this.preferences();
        if (data.kind === 'text') await sendText(server, token, data.text);
        else if (data.kind === 'gif') await sendGif(server, token, data.gif);
        else if (data.kind === 'search') result = { id, ok: true, gifs: await searchGifs(server, token, data.q, data.page, search!.signal) };
        else await sendFile(server, token, file!);
      }
    } catch (error) {
      // Rust commands reject with a plain string.
      result = { id, ok: false, error: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Envoi impossible.' };
    }
    if (search && search !== this.search) return;
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
