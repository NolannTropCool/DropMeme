import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { MediaEvent, PairingResponse, ServerEvent } from '@dropmeme/shared';
import { createApplication, type Application } from '../src/app.js';
import type { Config } from '../src/config.js';

const channelA = '123456789012345678';
const channelB = '223456789012345678';
const joinKey = 'test-invitation-key-at-least-24-chars';
const image = { url: 'https://cdn.discordapp.com/attachments/1/2/test.png', name: 'test.png', contentType: 'image/png', size: 4 };
let application: Application;
let config: Config;
let connected: boolean;
let fetchMedia: ReturnType<typeof vi.fn<typeof fetch>>;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  connected = true;
  config = { discordToken: 'unused', applicationId: channelA, guildId: channelA, allowedChannelIds: new Set([channelA, channelB]), publicUrl: 'http://localhost:3000', joinKey, port: 0, host: '127.0.0.1', databasePath: ':memory:', maxMediaBytes: 100, maxClients: 100 };
  fetchMedia = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/png', 'content-length': '4' } }));
  application = await createApplication(config, { connected: () => connected, channelName: async id => `channel-${id[0]}` }, { logger: false, fetchMedia });
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

async function open(token: string): Promise<{ socket: WebSocket; events: ServerEvent[] }> {
  const socket = new WebSocket(config.publicUrl.replace('http:', 'ws:') + '/v1/events'); sockets.push(socket);
  const events: ServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({ type: 'authenticate', token })));
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
