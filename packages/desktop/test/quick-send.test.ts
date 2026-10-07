import { beforeEach, describe, expect, test, vi } from 'vitest';
import { defaultSettings, settingsSchema } from '@dropmeme/shared';

const mocks = vi.hoisted(() => ({
  emitTo: vi.fn(), invoke: vi.fn(), readToken: vi.fn(), sendText: vi.fn(),
  channel: undefined as { onmessage: (payload: unknown) => void } | undefined,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class { onmessage = (_payload: unknown) => {}; constructor() { mocks.channel = this; } } }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: mocks.emitTo }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: vi.fn(async () => ({})) } }));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({ register: vi.fn(), unregister: vi.fn(), unregisterAll: vi.fn() }));
vi.mock('../src/preferences.js', () => ({ readToken: mocks.readToken }));
vi.mock('../src/send.js', () => ({ sendText: mocks.sendText }));
import { QuickSend, shortcutFromKeyboard, shortcutLabel } from '../src/quick-send-host.js';

const id = '0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a10';
const preferences = { settings: defaultSettings, server: 'https://dropmeme.example.com', subscription: { deviceId: 'device', channelId: '123456789012345678', channelName: 'memes' } };
async function relay(online: boolean): Promise<(payload: unknown) => Promise<unknown>> {
  const quickSend = new QuickSend(() => preferences); await quickSend.initialize(); quickSend.setOnline(online);
  return async payload => {
    mocks.emitTo.mockClear(); mocks.channel!.onmessage(payload);
    await new Promise(resolve => setTimeout(resolve, 0));
    return mocks.emitTo.mock.calls.find(call => call[1] === 'quick-send-result')?.[2];
  };
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.channel = undefined;
  mocks.emitTo.mockResolvedValue(undefined); mocks.readToken.mockResolvedValue('t'.repeat(43)); mocks.sendText.mockResolvedValue(undefined);
});

describe('quick-send relay in the main window', () => {
  test('listens only on the Rust channel, never on a forgeable webview event', async () => {
    await relay(true);
    expect(mocks.invoke).toHaveBeenCalledWith('quick_send_listen', { channel: mocks.channel });
  });
  test('sends validated text to the whole channel with the main token and answers the request id', async () => {
    const send = await relay(true);
    expect(await send({ id, kind: 'text', text: '  gg  ' })).toEqual({ id, ok: true });
    expect(mocks.sendText).toHaveBeenCalledWith('https://dropmeme.example.com', 't'.repeat(43), 'gg');
  });
  test('drops payloads outside the schema without sending', async () => {
    const send = await relay(true);
    for (const payload of [null, 'gg', { id, kind: 'text', text: '   ' }, { id, kind: 'text', text: 'x'.repeat(2001) }, { id: 'not-a-uuid', kind: 'text', text: 'gg' },
      { id, kind: 'text', text: 'gg', recipientId: id }, { id, kind: 'text', text: 'gg', token: 'x' }, { id, kind: 'file', text: 'gg' }]) {
      expect(await send(payload)).toBeUndefined();
    }
    expect(mocks.sendText).not.toHaveBeenCalled();
  });
  test('reports offline state and server refusals to the quick-send window', async () => {
    expect(await (await relay(false))({ id, kind: 'text', text: 'gg' })).toEqual({ id, ok: false, error: 'DropMeme n’est pas connecté au salon.' });
    expect(mocks.readToken).not.toHaveBeenCalled();
    mocks.sendText.mockRejectedValue(new Error('Limite de 20 envois par minute atteinte.'));
    expect(await (await relay(true))({ id, kind: 'text', text: 'gg' })).toEqual({ id, ok: false, error: 'Limite de 20 envois par minute atteinte.' });
  });
});

describe('quick-send shortcut', () => {
  const key = (key: string, code: string, modifiers: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({ key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers });
  test('builds plugin accelerators that follow the keyboard layout for letters', () => {
    expect(shortcutFromKeyboard(key(' ', 'Space', { ctrlKey: true, shiftKey: true }))).toBe(defaultSettings.quickSendShortcut);
    // AZERTY: the key labelled A reports the QWERTY Q position.
    expect(shortcutFromKeyboard(key('a', 'KeyQ', { altKey: true }))).toBe('Alt+A');
    expect(shortcutFromKeyboard(key('&', 'Digit1', { ctrlKey: true, metaKey: true }))).toBe('CommandOrControl+Super+Digit1');
    expect(shortcutFromKeyboard(key('Control', 'ControlLeft', { ctrlKey: true }))).toBeUndefined();
    expect(() => shortcutFromKeyboard(key('A', 'KeyQ', { shiftKey: true }))).toThrow('Ctrl, Alt ou Windows');
    expect(shortcutLabel('CommandOrControl+Shift+Space')).toBe('Ctrl + Maj + Espace');
    expect(shortcutLabel('Alt+Super+Digit1')).toBe('Alt + Win + 1');
  });
  test('older preferences without a shortcut get the default', () => {
    const { quickSendShortcut: _omitted, ...previous } = defaultSettings;
    expect(settingsSchema.parse(previous).quickSendShortcut).toBe('CommandOrControl+Shift+Space');
  });
});
