import { beforeEach, describe, expect, test, vi } from 'vitest';
import { defaultSettings, settingsSchema } from '@dropmeme/shared';

const mocks = vi.hoisted(() => ({
  emitTo: vi.fn(), invoke: vi.fn(), readToken: vi.fn(), sendText: vi.fn(), sendGif: vi.fn(), searchGifs: vi.fn(), sendFile: vi.fn(),
  channel: undefined as { onmessage: (payload: unknown) => void } | undefined,
  store: { get: vi.fn(), set: vi.fn(), save: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true, Channel: class { onmessage = (_payload: unknown) => {}; constructor() { mocks.channel = this; } } }));
vi.mock('@tauri-apps/plugin-store', () => ({ load: vi.fn(async () => mocks.store) }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: mocks.emitTo }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: vi.fn(async () => ({})) } }));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({ register: vi.fn(), unregister: vi.fn(), unregisterAll: vi.fn() }));
vi.mock('../src/preferences.js', () => ({ readToken: mocks.readToken }));
vi.mock('../src/send.js', () => ({ sendText: mocks.sendText, sendGif: mocks.sendGif, searchGifs: mocks.searchGifs, sendFile: mocks.sendFile }));
import { QuickSend, shortcutFromKeyboard, shortcutLabel } from '../src/quick-send-host.js';
import { Favorites } from '../src/favorites.js';

const id = '0b6f3f9e-2d4c-4f53-9a51-6f4f0c3b8a10';
const later = '1c7a4a0f-3e5d-4a64-8b62-7a5a1d4c9b21';
const gifs = { results: [{ id: 'dancing-cat', previewUrl: 'https://static.klipy.com/a.webp', url: 'https://static.klipy.com/a.mp4', width: 320, height: 240 }], hasNext: true };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const results = () => mocks.emitTo.mock.calls.filter(call => call[1] === 'quick-send-result').map(call => call[2]);
const preferences = { settings: defaultSettings, server: 'https://dropmeme.example.com', subscription: { deviceId: 'device', channelId: '123456789012345678', channelName: 'memes' } };
async function relay(online: boolean): Promise<(payload: unknown) => Promise<unknown>> {
  const quickSend = new QuickSend(() => preferences, favorites); await quickSend.initialize(); quickSend.setOnline(online);
  return async payload => {
    mocks.emitTo.mockClear(); mocks.channel!.onmessage(payload);
    await tick();
    return results()[0];
  };
}

// Main-side favorites without their tab: there is no DOM here.
let favorites: Favorites;
beforeEach(() => {
  vi.spyOn(Favorites.prototype as unknown as { render(): void }, 'render').mockImplementation(() => {});
  favorites = new Favorites(() => {});
  vi.clearAllMocks(); mocks.invoke.mockReset(); mocks.channel = undefined;
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
      { id, kind: 'text', text: 'gg', recipientId: id }, { id, kind: 'text', text: 'gg', token: 'x' }, { id, kind: 'file', text: 'gg' },
      { id, kind: 'search', q: ' a ', page: 1 }, { id, kind: 'search', q: 'x'.repeat(101), page: 1 }, { id, kind: 'search', q: 'chat', page: 21 }, { id, kind: 'search', q: 'chat', page: '1' }, { id, kind: 'search', q: 'chat' },
      { id, kind: 'gif', gif: '../items' }, { id, kind: 'gif', gif: 'cat', url: 'https://evil.example/x.gif' }, { id, kind: 'gif', gif: 'cat', recipientId: id },
      { id, kind: 'file', name: '', type: 'image/png' }, { id, kind: 'file', name: 'x'.repeat(257), type: 'image/png' }, { id, kind: 'file', name: 'a.png' },
      { id, kind: 'file', name: 'a.png', type: 'image/png', bytes: [1] }, { id, kind: 'file', name: 'a.png', type: 'image/png', recipientId: id }]) {
      expect(await send(payload)).toBeUndefined();
    }
    expect(mocks.sendText).not.toHaveBeenCalled(); expect(mocks.sendGif).not.toHaveBeenCalled(); expect(mocks.searchGifs).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith('take_file', expect.anything()); expect(mocks.sendFile).not.toHaveBeenCalled();
  });
  test('sends a staged file claimed from Rust, re-validated with the announced limit', async () => {
    const quickSend = new QuickSend(() => preferences, favorites); await quickSend.initialize(); quickSend.setOnline(true, { maxMediaBytes: 6 });
    const send = async (payload: unknown) => { mocks.emitTo.mockClear(); mocks.channel!.onmessage(payload); await tick(); return results()[0]; };
    mocks.invoke.mockImplementation(async (command: string) => command === 'take_file' ? new Uint8Array([137, 80, 78, 71]).buffer : undefined);
    mocks.sendFile.mockResolvedValue(undefined);
    expect(await send({ id, kind: 'file', name: 'capture-2026-10-07.png', type: 'image/png' })).toEqual({ id, ok: true });
    expect(mocks.invoke).toHaveBeenCalledWith('take_file', { id });
    const file = mocks.sendFile.mock.calls[0]![2] as File;
    expect([file.name, file.type, file.size]).toEqual(['capture-2026-10-07.png', 'image/png', 4]);
    expect(mocks.sendFile.mock.calls[0]!.slice(0, 2)).toEqual(['https://dropmeme.example.com', 't'.repeat(43)]);
    // Claimed then refused: Rust has already freed the bytes.
    expect(await send({ id, kind: 'file', name: 'page.svg', type: 'image/svg+xml' })).toEqual({ id, ok: false, error: 'Format refusé. Utilisez une image, un GIF, WebP, MP4, WebM ou MOV.' });
    mocks.invoke.mockImplementation(async (command: string) => command === 'take_file' ? new Uint8Array(7).buffer : undefined);
    expect(await send({ id, kind: 'file', name: 'a.png', type: 'image/png' })).toMatchObject({ ok: false, error: expect.stringContaining('trop volumineux') });
    mocks.invoke.mockRejectedValue('Le fichier n’est plus disponible. Déposez-le à nouveau.');
    expect(await send({ id, kind: 'file', name: 'a.png', type: 'image/png' })).toEqual({ id, ok: false, error: 'Le fichier n’est plus disponible. Déposez-le à nouveau.' });
    expect(mocks.sendFile).toHaveBeenCalledTimes(1);
  });
  test('searches and sends Klipy GIFs to the whole channel with the main token', async () => {
    const send = await relay(true);
    mocks.searchGifs.mockResolvedValue(gifs); mocks.sendGif.mockResolvedValue(undefined);
    expect(await send({ id, kind: 'search', q: ' chat ', page: 2 })).toEqual({ id, ok: true, gifs });
    expect(mocks.searchGifs).toHaveBeenCalledWith('https://dropmeme.example.com', 't'.repeat(43), 'chat', 2, expect.any(AbortSignal));
    expect(await send({ id, kind: 'gif', gif: 'dancing-cat' })).toEqual({ id, ok: true });
    expect(mocks.sendGif).toHaveBeenCalledWith('https://dropmeme.example.com', 't'.repeat(43), 'dancing-cat');
    mocks.searchGifs.mockRejectedValue(new Error('Limite de 60 recherches par minute atteinte.'));
    expect(await send({ id, kind: 'search', q: 'chat', page: 1 })).toEqual({ id, ok: false, error: 'Limite de 60 recherches par minute atteinte.' });
  });
  test('a newer search aborts the previous one, whose late answer is never relayed', async () => {
    await relay(true);
    const first = Promise.withResolvers<typeof gifs>();
    mocks.searchGifs.mockReturnValueOnce(first.promise).mockResolvedValueOnce(gifs);
    mocks.channel!.onmessage({ id, kind: 'search', q: 'cha', page: 1 });
    mocks.channel!.onmessage({ id: later, kind: 'search', q: 'chat', page: 1 });
    await tick(); first.resolve({ results: [], hasNext: false }); await tick();
    expect(results()).toEqual([{ id: later, ok: true, gifs }]);
    expect((mocks.searchGifs.mock.calls[0]![4] as AbortSignal).aborted).toBe(true);
  });
  test('announces GIF search and the upload limit of the server, with 0.2 defaults', async () => {
    const quickSend = new QuickSend(() => preferences, favorites); await quickSend.initialize();
    const state = () => mocks.emitTo.mock.calls.filter(call => call[1] === 'quick-send-state').at(-1)?.[2];
    quickSend.setOnline(true, { gifSearch: true, maxMediaBytes: 50 }); expect(state()).toEqual({ online: true, channelName: 'memes', gifSearch: true, maxMediaBytes: 50, favorites: [], received: [] });
    quickSend.setOnline(true, {}); expect(state()).toMatchObject({ gifSearch: false, maxMediaBytes: 25 * 1024 * 1024 });
    quickSend.setOnline(false, { gifSearch: true, maxMediaBytes: 50 }); expect(state()).toMatchObject({ online: false, gifSearch: false, maxMediaBytes: 25 * 1024 * 1024 });
  });
  test('reports offline state and server refusals to the quick-send window', async () => {
    expect(await (await relay(false))({ id, kind: 'text', text: 'gg' })).toEqual({ id, ok: false, error: 'DropMeme n’est pas connecté au salon.' });
    expect(mocks.readToken).not.toHaveBeenCalled();
    mocks.sendText.mockRejectedValue(new Error('Limite de 20 envois par minute atteinte.'));
    expect(await (await relay(true))({ id, kind: 'text', text: 'gg' })).toEqual({ id, ok: false, error: 'Limite de 20 envois par minute atteinte.' });
  });
});

describe('favorites relayed from the quick-send window', () => {
  const preview = { id: 'dancing-cat', previewUrl: 'https://static.klipy.com/a.webp', width: 320, height: 240 };
  const saved = () => mocks.store.set.mock.calls.at(-1)?.[1] as unknown[];
  const writes = () => mocks.invoke.mock.calls.filter(call => call[0] === 'favorite_write');
  test('drops favorite payloads outside the schema without storing anything', async () => {
    const send = await relay(true);
    for (const payload of [{ id, kind: 'favorite-gif', gif: preview }, { id, kind: 'favorite-gif', gif: preview, name: 'x'.repeat(65) }, { id, kind: 'favorite-gif', gif: preview, name: '  ' },
      { id, kind: 'favorite-gif', gif: { ...preview, previewUrl: 'http://evil.example/a.webp' }, name: 'chat' }, { id, kind: 'favorite-gif', gif: { ...preview, id: '../x' }, name: 'chat' },
      { id, kind: 'favorite-gif', gif: { ...preview, url: 'https://static.klipy.com/a.mp4' }, name: 'chat' }, { id, kind: 'favorite-gif', gif: preview, name: 'chat', file: 'a.png' },
      { id, kind: 'favorite-file', name: 'a.png' }, { id, kind: 'favorite-file', name: 'a.png', type: 'image/png', path: 'C:\\a.png' },
      { id, kind: 'favorite-received', media: '' }, { id, kind: 'favorite-received', media: 'm1', url: 'https://evil.example/a.gif' }]) {
      expect(await send(payload)).toBeUndefined();
    }
    expect(mocks.store.set).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalledWith('take_file', expect.anything());
  });
  test('stores a Klipy GIF as its slug and preview, offline and without the token, once', async () => {
    const pushed = vi.fn(); favorites = new Favorites(pushed);
    const send = await relay(false);
    expect(await send({ id, kind: 'favorite-gif', gif: preview, name: ' chat ' })).toEqual({ id, ok: true });
    expect(saved()).toEqual([{ id: expect.any(String), kind: 'gif', name: 'chat', gif: 'dancing-cat', previewUrl: preview.previewUrl, width: 320, height: 240 }]);
    expect(mocks.store.save).toHaveBeenCalled(); expect(pushed).toHaveBeenCalled(); expect(mocks.readToken).not.toHaveBeenCalled();
    expect(await send({ id, kind: 'favorite-gif', gif: preview, name: 'encore' })).toEqual({ id, ok: false, error: 'Ce GIF est déjà dans vos favoris.' });
    expect(favorites.list).toHaveLength(1);
  });
  test('copies a staged file under <uuid>.<ext>, never under a name chosen by the webview', async () => {
    const send = await relay(true);
    mocks.invoke.mockImplementation(async (command: string) => command === 'take_file' ? new Uint8Array([71, 73, 70]).buffer : undefined);
    expect(await send({ id, kind: 'favorite-file', name: '../../Mon chat.gif', type: 'image/gif' })).toEqual({ id, ok: true });
    expect(mocks.invoke).toHaveBeenCalledWith('take_file', { id });
    const [, bytes, options] = writes()[0]!;
    expect(new Uint8Array(bytes as ArrayBuffer)).toEqual(new Uint8Array([71, 73, 70]));
    expect((options as { headers: Record<string, string> }).headers['x-favorite']).toMatch(/^[0-9a-f-]{36}\.gif$/);
    expect(saved()).toEqual([expect.objectContaining({ kind: 'file', name: '../../Mon chat', ext: 'gif', size: 3 })]);
    expect(await send({ id, kind: 'favorite-file', name: 'clip.mov', type: 'video/quicktime' })).toMatchObject({ ok: false, error: expect.stringContaining('Format refusé pour les favoris') });
    expect(writes()).toHaveLength(1);
  });
  test('refuses a file past the caps and removes the copy when the list cannot be saved', async () => {
    const send = await relay(true);
    mocks.invoke.mockImplementation(async (command: string) => command === 'take_file' ? new Uint8Array(4).buffer : undefined);
    favorites.list = Array.from({ length: 200 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'gif' as const, name: 'g', gif: `g${i}`, previewUrl: preview.previewUrl, width: 1, height: 1 }));
    expect(await send({ id, kind: 'favorite-file', name: 'a.png', type: 'image/png' })).toEqual({ id, ok: false, error: '200 favoris maximum. Supprimez-en dans l’onglet Favoris.' });
    expect(writes()).toHaveLength(0);
    favorites.list = [];
    mocks.store.save.mockRejectedValueOnce(new Error('Disque plein.'));
    expect(await send({ id, kind: 'favorite-file', name: 'a.png', type: 'image/png' })).toEqual({ id, ok: false, error: 'Disque plein.' });
    const file = (writes()[0]![2] as { headers: Record<string, string> }).headers['x-favorite'];
    expect(mocks.invoke).toHaveBeenCalledWith('favorite_delete', { file });
  });
  test('downloads a received media through its ticket, and explains an expired one', async () => {
    const send = await relay(true);
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'video/mp4; codecs=avc1' } }));
    vi.stubGlobal('fetch', fetch);
    const url = 'https://dropmeme.example.com/v1/media/m1?device=d&expires=1&ticket=t';
    favorites.receive({ type: 'media', id: 'm1', channelId: '123456789012345678', kind: 'video', url, name: 'clip.mp4', author: 'Alice', createdAt: 0 });
    expect(await send({ id, kind: 'favorite-received', media: 'm1' })).toEqual({ id, ok: true });
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    expect(saved()).toEqual([expect.objectContaining({ kind: 'file', name: 'clip', ext: 'mp4', size: 2 })]);
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await send({ id, kind: 'favorite-received', media: 'm1' })).toMatchObject({ ok: false, error: expect.stringContaining('a expiré') });
    expect(await send({ id, kind: 'favorite-received', media: 'm2' })).toEqual({ id, ok: false, error: 'Ce média ne fait plus partie des derniers reçus.' });
    vi.unstubAllGlobals();
  });
  test('pushes the favorites and the latest received media with the state', async () => {
    const quickSend = new QuickSend(() => preferences, favorites); await quickSend.initialize();
    favorites.receive({ type: 'media', id: 'm1', channelId: '123456789012345678', kind: 'image', url: 'https://dropmeme.example.com/v1/media/m1', name: 'a.gif', author: 'Alice', createdAt: 0 });
    quickSend.push();
    expect(mocks.emitTo.mock.calls.at(-1)).toEqual(['quick-send', 'quick-send-state', expect.objectContaining({ favorites: [], received: [{ id: 'm1', kind: 'image', url: 'https://dropmeme.example.com/v1/media/m1', name: 'a.gif', author: 'Alice' }] })]);
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
