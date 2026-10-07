import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { EmbedType } from 'discord.js';
import { makeEmbed } from './discord-fixtures.js';
import { gifSearchResponseSchema, serverEventSchema, type MediaEvent, type PairingResponse, type ServerEvent } from '@dropmeme/shared';
import { createApplication, type Application } from '../src/app.js';
import type { Config } from '../src/config.js';
import { extractDiscordMedia } from '../src/discord-media.js';

const channelA = '123456789012345678';
const channelB = '223456789012345678';
const joinKey = 'test-invitation-key-at-least-24-chars';
const image = { url: 'https://cdn.discordapp.com/attachments/1/2/test.png', name: 'test.png', contentType: 'image/png', size: 4 };
let application: Application;
let config: Config;
let connected: boolean;
let fetchMedia: ReturnType<typeof vi.fn<typeof fetch>>;
let fetchGifs: ReturnType<typeof vi.fn<typeof fetch>>;
const sockets: WebSocket[] = [];
const gifApiKey = 'klipy-fixture-key-do-not-leak';
const klipyUrl = (name: string) => `https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/${name}`;
const klipyFile = (url: string) => ({ url, width: 320, height: 240, size: 50 });
const klipyItems = [
  { id: 9007199254740993, slug: 'dancing-cat', type: 'gif', title: 'Cat', file: { md: { mp4: klipyFile(klipyUrl('cat.mp4')), webp: klipyFile(klipyUrl('cat.webp')) }, xs: { webp: klipyFile(klipyUrl('cat-xs.webp')) } } },
  { slug: 'sponsored', type: 'ad', file: { md: { mp4: klipyFile(klipyUrl('ad.mp4')) }, xs: { webp: klipyFile(klipyUrl('ad.webp')) } } },
  { slug: 'evil-host', type: 'gif', file: { md: { mp4: klipyFile('https://evil.example/ii/a/b/c/x.mp4') }, xs: { webp: klipyFile(klipyUrl('evil.webp')) } } },
  // md.mp4 is missing: falls back to hd.mp4, and the preview to sm.webp.
  { slug: 'fallback', type: 'gif', file: { hd: { mp4: klipyFile(klipyUrl('hd.mp4')) }, sm: { webp: klipyFile(klipyUrl('sm.webp')) } } },
  { slug: 'webp-only', type: 'gif', file: { md: { webp: klipyFile(klipyUrl('only.webp')) }, xs: { webp: klipyFile(klipyUrl('only-xs.webp')) } } },
];

beforeEach(async () => {
  connected = true;
  config = { discordToken: 'unused', applicationId: channelA, guildId: channelA, allowedChannelIds: new Set([channelA, channelB]), publicUrl: 'http://localhost:3000', joinKey, port: 0, host: '127.0.0.1', databasePath: ':memory:', maxMediaBytes: 100, maxClients: 100, gifApiKey };
  fetchMedia = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/png', 'content-length': '4' } }));
  fetchGifs = vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = new URL(String(input));
    const slugs = url.searchParams.get('slugs');
    return Response.json({ result: true, data: { data: slugs ? klipyItems.filter(item => item.slug === slugs) : klipyItems, current_page: 1, per_page: 24, has_next: true } });
  });
  application = await createApplication(config, { connected: () => connected, channelName: async id => `channel-${id[0]}` }, { logger: false, fetchMedia, fetchGifs });
  config.publicUrl = await application.app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await application.app.close();
});

async function pair(channelId = channelA): Promise<PairingResponse> {
  const response = await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { channelId, joinKey } });
  expect(response.statusCode).toBe(201);
  return response.json() as PairingResponse;
}

async function open(token: string, profile?: { name: string; acceptDirect: boolean }): Promise<{ socket: WebSocket; events: ServerEvent[] }> {
  const socket = new WebSocket(config.publicUrl.replace('http:', 'ws:') + '/v1/events'); sockets.push(socket);
  const events: ServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({ type: 'authenticate', token, ...(profile ? { protocol: 2, version: '0.2.0', profile } : {}) })));
    socket.on('message', bytes => { const event = JSON.parse(bytes.toString()) as ServerEvent; events.push(event); if (event.type === 'ready') resolve(); });
    socket.once('close', () => reject(new Error('Socket closed before ready')));
  });
  return { socket, events };
}

async function nextMedia(token: string): Promise<MediaEvent> {
  const { socket } = await open(token);
  const result = new Promise<MediaEvent>(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()) as MediaEvent)));
  application.publish(channelA, 'Alice', image);
  return result;
}

describe('HTTP and real WebSocket integration', () => {
  test('presence and consent isolate direct text and its resource from other devices', async () => {
    const sender = await pair(); const recipient = await pair(); const other = await pair(channelB);
    const a = await open(sender.token, { name: 'Alice', acceptDirect: false });
    const b = await open(recipient.token, { name: 'Bob', acceptDirect: false });
    const c = await open(other.token, { name: 'Charlie', acceptDirect: true });
    await vi.waitFor(() => expect(a.events.filter(event => event.type === 'presence').at(-1)).toMatchObject({ peers: [{ name: 'Alice' }, { name: 'Bob', acceptDirect: false }] }));
    expect(c.events.filter(event => event.type === 'presence').at(-1)).toMatchObject({ peers: [{ name: 'Charlie' }] });
    const post = () => application.app.inject({ method: 'POST', url: '/v2/send/text', headers: { authorization: `Bearer ${sender.token}` }, payload: { text: '<img onerror=alert(1)>', recipientId: recipient.deviceId } });
    expect((await post()).statusCode).toBe(403);
    b.socket.send(JSON.stringify({ type: 'profile', profile: { name: 'Bob', acceptDirect: true } }));
    await vi.waitFor(() => expect(a.events.filter(event => event.type === 'presence').at(-1)).toMatchObject({ peers: [{ name: 'Alice' }, { name: 'Bob', acceptDirect: true }] }));
    expect((await post()).statusCode).toBe(201);
    await vi.waitFor(() => expect(b.events.filter(event => event.type === 'media')).toHaveLength(1));
    expect(a.events.filter(event => event.type === 'media')).toHaveLength(0);
    expect(c.events.filter(event => event.type === 'media')).toHaveLength(0);
    const media = b.events.find(event => event.type === 'media') as MediaEvent;
    expect(media).toMatchObject({ kind: 'text', author: 'Alice', text: '<img onerror=alert(1)>' });
    const url = new URL(media.url);
    expect((await application.app.inject(url.pathname + url.search)).body).toBe('<img onerror=alert(1)>');
    // Even a valid ticket for a different same-channel device cannot access a targeted resource.
    url.searchParams.set('device', sender.deviceId);
    url.searchParams.set('ticket', (await import('node:crypto')).createHmac('sha256', application.store.signingKey).update(`${media.id}:${sender.deviceId}:${url.searchParams.get('expires')}`).digest('base64url'));
    expect((await application.app.inject(url.pathname + url.search)).statusCode).toBe(404);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const uploaded = await application.app.inject({ method: 'POST', url: `/v2/send/file?recipientId=${recipient.deviceId}`, headers: { authorization: `Bearer ${sender.token}`, 'content-type': 'multipart/form-data; boundary=target' }, payload: Buffer.concat([Buffer.from('--target\r\nContent-Disposition: form-data; name="file"; filename="one.gif"\r\nContent-Type: image/gif\r\n\r\n'), gif, Buffer.from('\r\n--target--\r\n')]) });
    expect(uploaded.statusCode).toBe(201);
    await vi.waitFor(() => expect(b.events.filter(event => event.type === 'media')).toHaveLength(2));
    expect(b.events.filter(event => event.type === 'media').at(-1)).toMatchObject({ kind: 'image', animation: true, name: 'one.gif', author: 'Alice' });
    expect(a.events.filter(event => event.type === 'media')).toHaveLength(0);
    expect(c.events.filter(event => event.type === 'media')).toHaveLength(0);
    b.socket.send(JSON.stringify({ type: 'profile', profile: { name: 'Bob', acceptDirect: false } }));
    await vi.waitFor(() => expect(a.events.filter(event => event.type === 'presence').at(-1)).toMatchObject({ peers: [{ name: 'Alice' }, { name: 'Bob', acceptDirect: false }] }));
    expect((await post()).statusCode).toBe(403);
    expect((await application.app.inject({ method: 'POST', url: '/v2/send/text', headers: { authorization: `Bearer ${sender.token}` }, payload: { text: 'cross channel', recipientId: other.deviceId } })).statusCode).toBe(403);
  });

  test('uploads retain animated WebP bytes, reject HTML and enforce size and connected authentication', async () => {
    const sender = await pair(); const client = await open(sender.token, { name: 'Alice', acceptDirect: false });
    const upload = (bytes: Buffer, name = 'animation.webp') => application.app.inject({
      method: 'POST', url: '/v2/send/file', headers: { authorization: `Bearer ${sender.token}`, 'content-type': 'multipart/form-data; boundary=dropmeme' },
      payload: Buffer.concat([Buffer.from(`--dropmeme\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/webp\r\n\r\n`), bytes, Buffer.from('\r\n--dropmeme--\r\n')]),
    });
    const webp = Buffer.from('RIFF0123WEBPVP8X0000ANIM0000ANMF0000');
    expect((await upload(webp)).statusCode).toBe(201);
    await vi.waitFor(() => expect(client.events.filter(event => event.type === 'media')).toHaveLength(1));
    const media = client.events.find(event => event.type === 'media') as MediaEvent;
    expect(media).toMatchObject({ kind: 'image', animation: true, author: 'Alice' });
    const url = new URL(media.url); const response = await application.app.inject(url.pathname + url.search);
    expect(response.headers['content-type']).toBe('image/webp'); expect(response.rawPayload).toEqual(webp);
    expect(fetchMedia).not.toHaveBeenCalled();
    expect((await upload(Buffer.from('<html>not an image</html>'), 'fake.gif')).statusCode).toBe(415);
    expect((await upload(Buffer.alloc(101))).statusCode).toBe(413);
    expect((await application.app.inject({ method: 'POST', url: '/v2/send/text', payload: { text: 'anonymous' } })).statusCode).toBe(401);
    expect((await application.app.inject({ method: 'POST', url: '/v2/send/text', headers: { authorization: `Bearer ${sender.token}` }, payload: { text: 'é'.repeat(2000) } })).statusCode).toBe(201);
  });

  test('broadcast text reaches new clients only; send limits survive reconnects', async () => {
    const sender = await pair(); const newer = await open(sender.token, { name: 'Alice', acceptDirect: true });
    const legacy = await open((await pair()).token);
    const sendText = () => application.app.inject({ method: 'POST', url: '/v2/send/text', headers: { authorization: `Bearer ${sender.token}` }, payload: { text: 'Bonjour' } });
    expect((await sendText()).statusCode).toBe(201);
    await vi.waitFor(() => expect(newer.events.filter(event => event.type === 'media')).toHaveLength(1));
    expect(legacy.events.filter(event => event.type === 'presence' || event.type === 'media')).toHaveLength(0);
    for (let i = 1; i < 20; i++) expect((await sendText()).statusCode).toBe(201);
    expect((await sendText()).statusCode).toBe(429);
    const closed = new Promise<void>(resolve => newer.socket.once('close', () => resolve())); newer.socket.close(); await closed;
    await vi.waitFor(async () => expect((await sendText()).statusCode).toBe(401));
    await open(sender.token, { name: 'Alice', acceptDirect: false });
    expect((await sendText()).statusCode).toBe(429);
  });
  test('Tenor GIF picker media is proxied as looping video, not as a thumbnail or an external player', async () => {
    const device = await pair(); const { socket } = await open(device.token);
    const arrival = new Promise<MediaEvent>(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()) as MediaEvent)));
    const url = 'https://media.tenor.com/fixtureAAAAC/animation.mp4';
    const incoming = extractDiscordMedia({ id: 'gif-message', attachments: new Map(), embeds: [makeEmbed({ type: EmbedType.GIFV, video: { url } })] })[0]!;
    expect(application.publish(channelA, 'Discord', incoming)).toBe(true);
    expect(application.publish(channelA, 'Discord', incoming)).toBe(false);
    const event = await arrival;
    expect(event.kind).toBe('video'); expect(event.loop).toBe(true);
    expect(event.url).toMatch(new RegExp(`^${config.publicUrl}/v1/media/`));
    fetchMedia.mockImplementationOnce(async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4' } }));
    const resource = new URL(event.url);
    const response = await application.app.inject(resource.pathname + resource.search);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(fetchMedia.mock.calls[0]?.[0]).toBe(url);
    expect(fetchMedia.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
  test('Klipy search needs a connected device, keeps provider order, drops ads and untrusted URLs, caches and is rate-limited', async () => {
    const search = (q: string, token?: string) => application.app.inject({ url: `/v2/gifs/search?q=${encodeURIComponent(q)}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await search('chat')).statusCode).toBe(401);
    const device = await pair();
    expect((await search('chat', device.token)).statusCode).toBe(401);
    const { events } = await open(device.token, { name: 'Alice', acceptDirect: false });
    expect(events.find(event => event.type === 'ready')).toMatchObject({ gifSearch: true });
    expect((await search(' a ', device.token)).statusCode).toBe(400);
    expect((await search('x'.repeat(101), device.token)).statusCode).toBe(400);
    expect((await application.app.inject({ url: '/v2/gifs/search?q=chat&page=21', headers: { authorization: `Bearer ${device.token}` } })).statusCode).toBe(400);
    const first = await search(' Chat ', device.token);
    expect(first.statusCode).toBe(200);
    expect(gifSearchResponseSchema.parse(first.json())).toEqual({ hasNext: true, results: [
      { id: 'dancing-cat', previewUrl: klipyUrl('cat-xs.webp'), url: klipyUrl('cat.mp4'), width: 320, height: 240 },
      { id: 'fallback', previewUrl: klipyUrl('sm.webp'), url: klipyUrl('hd.mp4'), width: 320, height: 240 },
      { id: 'webp-only', previewUrl: klipyUrl('only-xs.webp'), url: klipyUrl('only.webp'), width: 320, height: 240 },
    ] });
    expect((await search('chat', device.token)).json()).toEqual(first.json());
    expect(fetchGifs).toHaveBeenCalledTimes(1);
    const upstream = new URL(String(fetchGifs.mock.calls[0]![0]));
    expect(upstream.origin + upstream.pathname).toBe(`https://api.klipy.com/api/v1/${gifApiKey}/gifs/search`);
    expect(Object.fromEntries(upstream.searchParams)).toMatchObject({ q: 'chat', per_page: '24', page: '1', locale: 'fr', content_filter: 'medium', format_filter: 'mp4,webp' });
    expect(upstream.searchParams.get('customer_id')).toMatch(/^[0-9a-f]{32}$/);
    expect(upstream.searchParams.get('customer_id')).not.toContain(device.deviceId.slice(0, 8));
    expect(fetchGifs.mock.calls[0]![1]?.redirect).toBe('error');
    fetchGifs.mockImplementationOnce(async () => new Response(`invalid key ${gifApiKey}`, { status: 401 }));
    const failed = await search('chien', device.token);
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'La recherche de GIF est indisponible pour le moment.' });
    expect(first.body + failed.body).not.toContain(gifApiKey);
    // A failed lookup is not cached.
    expect((await search('chien', device.token)).statusCode).toBe(200);
    for (let i = 4; i < 60; i++) expect((await search('chat', device.token)).statusCode).toBe(200);
    expect((await search('chat', device.token)).statusCode).toBe(429);
    // Searching does not consume the send quota.
    expect((await application.app.inject({ method: 'POST', url: '/v2/send/text', headers: { authorization: `Bearer ${device.token}` }, payload: { text: 'ok' } })).statusCode).toBe(201);
  });

  test('without GIF_API_KEY, GIF search and sending are disabled and announced as such', async () => {
    config.gifApiKey = undefined;
    const device = await pair();
    const { events } = await open(device.token, { name: 'Alice', acceptDirect: false });
    expect(events.find(event => event.type === 'ready')).toMatchObject({ gifSearch: false });
    const authorization = `Bearer ${device.token}`;
    expect((await application.app.inject({ url: '/v2/gifs/search?q=chat', headers: { authorization } })).statusCode).toBe(503);
    expect((await application.app.inject({ method: 'POST', url: '/v2/send/gif', headers: { authorization }, payload: { id: 'dancing-cat' } })).statusCode).toBe(503);
    expect(fetchGifs).not.toHaveBeenCalled();
  });

  test('ready announces the upload limit so clients refuse oversized files before uploading', async () => {
    const { events } = await open((await pair()).token, { name: 'Alice', acceptDirect: false });
    const ready = serverEventSchema.parse(events.find(event => event.type === 'ready'));
    expect(ready).toMatchObject({ type: 'ready', protocol: 2, maxMediaBytes: config.maxMediaBytes });
  });

  test('sent GIFs are re-resolved by slug, reach the sender channel only and share the send quota', async () => {
    const sender = await pair(); const recipient = await pair(); const other = await pair(channelB);
    const a = await open(sender.token, { name: 'Alice', acceptDirect: false });
    const b = await open(recipient.token, { name: 'Bob', acceptDirect: false });
    const c = await open(other.token, { name: 'Charlie', acceptDirect: true });
    const sendGif = (payload: object) => application.app.inject({ method: 'POST', url: '/v2/send/gif', headers: { authorization: `Bearer ${sender.token}` }, payload });
    expect((await application.app.inject({ method: 'POST', url: '/v2/send/gif', payload: { id: 'dancing-cat' } })).statusCode).toBe(401);
    for (const payload of [{ id: '../search' }, { id: 'a'.repeat(129) }, { id: 'dancing-cat', url: 'https://evil.example/x.mp4' }, { id: 'dancing-cat', recipientId: 'nope' }]) expect((await sendGif(payload)).statusCode).toBe(400);
    expect((await sendGif({ id: 'dancing-cat', recipientId: recipient.deviceId })).statusCode).toBe(403);
    expect((await sendGif({ id: 'sponsored' })).statusCode).toBe(404);
    expect((await sendGif({ id: 'evil-host' })).statusCode).toBe(404);
    const sent = await sendGif({ id: 'dancing-cat' });
    expect(sent.statusCode).toBe(201); expect(sent.body).not.toContain(gifApiKey);
    expect(new URL(String(fetchGifs.mock.calls.at(-1)![0])).searchParams.get('slugs')).toBe('dancing-cat');
    await vi.waitFor(() => expect(b.events.filter(event => event.type === 'media')).toHaveLength(1));
    const media = b.events.find(event => event.type === 'media') as MediaEvent;
    expect(media).toMatchObject({ id: sent.json().id, kind: 'video', loop: true, animation: true, author: 'Alice', name: 'animation.mp4' });
    expect(a.events.filter(event => event.type === 'media')).toHaveLength(1);
    expect(c.events.filter(event => event.type === 'media')).toHaveLength(0);
    expect(media.url).not.toContain('klipy');
    fetchMedia.mockImplementationOnce(async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4' } }));
    const resource = new URL(media.url);
    expect((await application.app.inject(resource.pathname + resource.search)).headers['content-type']).toBe('video/mp4');
    expect(fetchMedia.mock.calls[0]?.[0]).toBe(klipyUrl('cat.mp4'));
    expect(fetchMedia.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect((await sendGif({ id: 'webp-only' })).statusCode).toBe(201);
    await vi.waitFor(() => expect(b.events.filter(event => event.type === 'media')).toHaveLength(2));
    const webp = b.events.filter(event => event.type === 'media').at(-1) as MediaEvent;
    expect(webp).toMatchObject({ kind: 'image', animation: true, name: 'animation.webp' });
    fetchMedia.mockImplementationOnce(async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));
    const page = new URL(webp.url);
    expect((await application.app.inject(page.pathname + page.search)).statusCode).toBe(502);
    // Both 404s above counted, like any accepted send attempt; the 403 did not.
    for (let i = 4; i < 20; i++) expect((await sendGif({ id: 'fallback' })).statusCode).toBe(201);
    expect((await sendGif({ id: 'fallback' })).statusCode).toBe(429);
    expect((await application.app.inject({ method: 'POST', url: '/v2/send/text', headers: { authorization: `Bearer ${sender.token}` }, payload: { text: 'ok' } })).statusCode).toBe(429);
  });

  test('a direct GIF needs the recipient consent and reaches only that recipient', async () => {
    const sender = await pair(); const recipient = await pair();
    const a = await open(sender.token, { name: 'Alice', acceptDirect: false });
    const b = await open(recipient.token, { name: 'Bob', acceptDirect: true });
    const sent = await application.app.inject({ method: 'POST', url: '/v2/send/gif', headers: { authorization: `Bearer ${sender.token}` }, payload: { id: 'fallback', recipientId: recipient.deviceId } });
    expect(sent.statusCode).toBe(201);
    await vi.waitFor(() => expect(b.events.filter(event => event.type === 'media')).toHaveLength(1));
    expect(a.events.filter(event => event.type === 'media')).toHaveLength(0);
  });

  test('a deleted Discord message is retracted from its channel and its media tickets stop resolving', async () => {
    const viewer = await open((await pair()).token, { name: 'Bob', acceptDirect: false });
    const other = await open((await pair(channelB)).token, { name: 'Eve', acceptDirect: false });
    application.publish(channelA, 'Alice', { ...image, sourceId: 'm1:a' });
    application.publishText(channelA, 'Alice', 'Oups', 'm1:text');
    application.publish(channelA, 'Alice', { ...image, sourceId: 'm2:a' });
    await vi.waitFor(() => expect(viewer.events.filter(event => event.type === 'media')).toHaveLength(3));
    const [first, text, kept] = viewer.events.filter((event): event is MediaEvent => event.type === 'media');
    application.retract(channelB, ['m1']);
    application.retract(channelA, ['m1', 'unknown']);
    await vi.waitFor(() => expect(viewer.events.at(-1)).toEqual({ type: 'retract', ids: [first!.id, text!.id] }));
    expect(other.events.some(event => event.type === 'retract')).toBe(false);
    const status = async (media: MediaEvent) => { const url = new URL(media.url); return (await application.app.inject(url.pathname + url.search)).statusCode; };
    expect(await status(first!)).toBe(404);
    expect(await status(kept!)).toBe(200);
  });
  test('pairing requires an allowed channel and secret or a valid one-use code', async () => {
    expect((await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { channelId: channelA } })).statusCode).toBe(400);
    expect((await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { channelId: channelA, joinKey: 'wrong-key-at-least-24-chars' } })).statusCode).toBe(401);
    expect((await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { channelId: '323456789012345678', joinKey } })).statusCode).toBe(401);
    const code = application.store.createPairing(channelA, 'memes');
    const first = await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { code } });
    expect(first.statusCode).toBe(201);
    expect(first.json().channelName).toBe('memes');
    expect((await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { code } })).statusCode).toBe(401);
  });

  test('code pairing still works when direct-ID pairing is disabled', async () => {
    config.joinKey = undefined;
    expect((await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { channelId: channelA, joinKey } })).statusCode).toBe(401);
    const code = application.store.createPairing(channelA, 'memes');
    expect((await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { code } })).statusCode).toBe(201);
  });

  test('fanout is isolated by channel and reports Discord availability', async () => {
    const a = await open((await pair(channelA)).token);
    const b = await open((await pair(channelB)).token);
    const arrived = new Promise<void>(resolve => a.socket.once('message', () => resolve()));
    expect(application.publish(channelA, 'Alice', image)).toBe(true);
    expect(application.publish('323456789012345678', 'Alice', image)).toBe(false);
    await arrived;
    expect(a.events.filter(event => event.type === 'media')).toHaveLength(1);
    expect(b.events.filter(event => event.type === 'media')).toHaveLength(0);
    connected = false;
    const status = new Promise<void>(resolve => b.socket.once('message', () => resolve()));
    application.publishStatus(); await status;
    expect(b.events.at(-1)).toEqual({ type: 'status', discordConnected: false });
    expect((await application.app.inject('/readyz')).statusCode).toBe(503);
    expect((await application.app.inject('/healthz')).statusCode).toBe(200);
  });

  test('media is fetched with TLS/redirect protections, cached and range-readable', async () => {
    const device = await pair();
    const media = await nextMedia(device.token);
    const path = new URL(media.url).pathname + new URL(media.url).search;
    const response = await application.app.inject(path);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const partial = await application.app.inject({ url: path, headers: { range: 'bytes=1-2' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload).toEqual(Buffer.from([2, 3]));
    expect(partial.headers['content-range']).toBe('bytes 1-2/4');
    expect((await application.app.inject({ url: path, headers: { range: 'bytes=99-' } })).statusCode).toBe(416);
    expect(fetchMedia).toHaveBeenCalledTimes(1);
    expect(fetchMedia.mock.calls[0]?.[1]?.redirect).toBe('error');
    const tampered = new URL(media.url); tampered.searchParams.set('device', 'other-device');
    expect((await application.app.inject(tampered.pathname + tampered.search)).statusCode).toBe(401);
  });

  test('server rejects mismatched media types and streamed oversize data', async () => {
    const device = await pair();
    const media = await nextMedia(device.token);
    const url = new URL(media.url); const path = url.pathname + url.search;
    fetchMedia.mockImplementationOnce(async () => new Response('<script>bad</script>', { headers: { 'content-type': 'text/html' } }));
    expect((await application.app.inject(path)).statusCode).toBe(502);
    fetchMedia.mockImplementationOnce(async () => new Response(new Uint8Array(101), { headers: { 'content-type': 'image/png' } }));
    expect((await application.app.inject(path)).statusCode).toBe(502);
  });

  test('unsubscribe invalidates credentials, disconnects sockets and revokes media tickets', async () => {
    const device = await pair();
    const { socket } = await open(device.token);
    const event = new Promise<MediaEvent>(resolve => socket.once('message', bytes => resolve(JSON.parse(bytes.toString()) as MediaEvent)));
    application.publish(channelA, 'Alice', image);
    const media = await event;
    const closed = new Promise<number>(resolve => socket.once('close', resolve));
    const response = await application.app.inject({ method: 'DELETE', url: '/v1/device', headers: { authorization: `Bearer ${device.token}` } });
    expect(response.statusCode).toBe(204); expect(await closed).toBe(4001);
    expect(application.store.authenticate(device.token)).toBeUndefined();
    const url = new URL(media.url);
    expect((await application.app.inject(url.pathname + url.search)).statusCode).toBe(404);
  });

  test('WebSocket denies invalid credentials and hostile browser origins', async () => {
    for (const origin of [undefined, 'https://evil.example']) {
      const socket = new WebSocket(config.publicUrl.replace('http:', 'ws:') + '/v1/events', origin ? { origin } : {}); sockets.push(socket);
      const code = await new Promise<number>(resolve => {
        socket.on('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: 'invalid-but-long-enough-token-123456' })));
        socket.on('close', resolve);
      });
      expect([4001, 1008]).toContain(code);
    }
  });

  test('pairing brute force is rate-limited', async () => {
    for (let i = 0; i < 10; i++) await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { code: 'AAAAAAAA-BBBBBBBB' } });
    expect((await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { code: 'AAAAAAAA-BBBBBBBB' } })).statusCode).toBe(429);
  });
  test('device inventory is bounded and duplicate sessions are denied', async () => {
    config.maxClients = 1;
    const device = await pair();
    const first = await open(device.token);
    expect((await application.app.inject({ method: 'POST', url: '/v1/pair', payload: { channelId: channelA, joinKey } })).statusCode).toBe(503);
    config.maxClients = 10;
    const socket = new WebSocket(config.publicUrl.replace('http:', 'ws:') + '/v1/events'); sockets.push(socket);
    const closed = new Promise<number>(resolve => {
      socket.once('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: device.token })));
      socket.once('close', resolve);
    });
    expect(await closed).toBe(4009);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
  });
});
