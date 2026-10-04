import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { pairingRequestSchema, type ServerEvent } from '@dropmeme/shared';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import { Store, equalSecret, type Device } from './store.js';
import { MediaCatalog, classifyMedia, type IncomingMedia, type StoredMedia } from './media.js';

export interface DiscordBridge {
  connected(): boolean;
  channelName(id: string): Promise<string | undefined>;
}
export interface Application {
  app: FastifyInstance;
  store: Store;
  publish(channelId: string, author: string, input: IncomingMedia): boolean;
  publishStatus(): void;
}
const origins = new Set(['tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost', 'http://localhost:1420']);
const authenticateSchema = z.object({ type: z.literal('authenticate'), token: z.string().min(32).max(128) }).strict();

export async function createApplication(config: Config, discord: DiscordBridge, options: {
  logger?: boolean;
  fetchMedia?: typeof fetch;
} = {}): Promise<Application> {
  const app = Fastify({
    logger: options.logger === false ? false : {
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: { req: req => ({ method: req.method, url: req.url.split('?')[0] ?? '/', remoteAddress: req.ip }) },
    },
    bodyLimit: 2048,
    // Use the socket's IP, not an untrusted X-Forwarded-For header.
    trustProxy: false,
    requestTimeout: 20_000,
  });
  const store = new Store(config.databasePath);
  const catalog = new MediaCatalog(store.signingKey, config.maxMediaBytes);
  const peers = new Map<WebSocket, Device>();
  const cache = new Map<string, { bytes: Buffer; contentType: string; expires: number }>();
  const downloads = new Map<string, Promise<{ bytes: Buffer; contentType: string }>>();
  let cacheBytes = 0;
  const maxCacheBytes = 64 * 1024 * 1024;
  const fetchMedia = options.fetchMedia ?? fetch;

  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || origins.has(origin)), methods: ['GET', 'POST', 'DELETE'] });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 2048 } });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error as { statusCode?: unknown };
    const status = typeof candidate.statusCode === 'number' && candidate.statusCode < 500 ? candidate.statusCode : 500;
    if (status === 500) app.log.error('Request failed');
    void reply.code(status).send({ error: status === 500 ? 'Erreur interne.' : 'Requête refusée.' });
  });

  const send = (socket: WebSocket, event: ServerEvent) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 128 * 1024) { socket.close(1013, 'Client trop lent'); return; }
    socket.send(JSON.stringify(event));
  };

  app.get('/healthz', async () => ({ ok: true, discordConnected: discord.connected() }));
  app.get('/readyz', async (_request, reply) => {
    return reply.code(discord.connected() ? 200 : 503).send({ ok: discord.connected() });
  });

  app.post('/v1/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = pairingRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Code ou ID de salon invalide.' });
    if (store.deviceCount() >= config.maxClients) return reply.code(503).send({ error: 'Nombre maximal d’appareils atteint.' });
    let subscription: { channelId: string; channelName: string } | undefined;
    if ('code' in parsed.data) subscription = store.consumePairing(parsed.data.code);
    else if (config.joinKey && equalSecret(parsed.data.joinKey, config.joinKey) && config.allowedChannelIds.has(parsed.data.channelId)) {
      const channelName = await discord.channelName(parsed.data.channelId);
      if (channelName) subscription = { channelId: parsed.data.channelId, channelName };
    }
    if (!subscription || !config.allowedChannelIds.has(subscription.channelId)) {
      return reply.code(401).send({ error: 'Invitation invalide, expirée ou salon non autorisé.' });
    }
    const device = store.createDevice(subscription.channelId, subscription.channelName);
    return reply.code(201).header('Cache-Control', 'no-store').send({ token: device.token, deviceId: device.id, channelId: device.channelId, channelName: device.channelName });
  });

  app.delete('/v1/device', async (request, reply) => {
    const authorization = request.headers.authorization;
    const device = authorization?.startsWith('Bearer ') ? store.authenticate(authorization.slice(7)) : undefined;
    if (!device) return reply.code(401).send({ error: 'Appareil non authentifié.' });
    store.revoke(device.id);
    for (const [socket, peer] of peers) if (peer.id === device.id) socket.close(4001, 'Abonnement révoqué');
    return reply.code(204).send();
  });

  app.get('/v1/events', { websocket: true }, (socket, request) => {
    if ((request.headers.origin && !origins.has(request.headers.origin)) || app.websocketServer.clients.size > config.maxClients) {
      socket.close(1008, 'Connexion refusée'); return;
    }
    const timeout = setTimeout(() => socket.close(4001, 'Authentification requise'), 5000);
    timeout.unref();
    socket.on('error', () => { /* close/error are handled by ws; never log credentials. */ });
    socket.on('close', () => { clearTimeout(timeout); peers.delete(socket); });
    socket.on('message', (data, binary) => {
      if (peers.has(socket) || binary) { socket.close(1008, 'Message invalide'); return; }
      try {
        const parsed = authenticateSchema.safeParse(JSON.parse(data.toString()));
        const device = parsed.success ? store.authenticate(parsed.data.token) : undefined;
        if (!device || !config.allowedChannelIds.has(device.channelId)) { socket.close(4001, 'Abonnement invalide'); return; }
        if ([...peers.values()].some(peer => peer.id === device.id)) { socket.close(4009, 'Appareil déjà connecté'); return; }
        clearTimeout(timeout);
        peers.set(socket, device);
        send(socket, { type: 'ready', channelId: device.channelId, channelName: device.channelName, discordConnected: discord.connected() });
      } catch { socket.close(1008, 'Message invalide'); }
    });
  });

  const alive = new WeakSet<WebSocket>();
  app.websocketServer.on('connection', socket => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
  });
  const heartbeat = setInterval(() => {
    for (const socket of app.websocketServer.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket); socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  async function download(media: StoredMedia): Promise<{ bytes: Buffer; contentType: string }> {
    for (const [id, value] of cache) if (value.expires <= Date.now()) { cache.delete(id); cacheBytes -= value.bytes.length; }
    const cached = cache.get(media.id);
    if (cached) return cached;
    const pending = downloads.get(media.id);
    if (pending) return pending;
    if (downloads.size >= 4) throw new Error('Téléchargements simultanés limités');
    const operation = (async () => {
      const upstream = await fetchMedia(media.url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!upstream.ok || !upstream.body) throw new Error('CDN indisponible');
      const contentType = upstream.headers.get('content-type')?.split(';')[0]?.toLowerCase() ?? '';
      if (classifyMedia({ ...media, contentType }, config.maxMediaBytes) !== media.kind || Number(upstream.headers.get('content-length') ?? 0) > config.maxMediaBytes) {
        await upstream.body.cancel(); throw new Error('Type ou taille du média refusé');
      }
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > config.maxMediaBytes) throw new Error('Média trop volumineux');
          chunks.push(result.value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      if (!bytes.length) throw new Error('Média vide');
      while (cacheBytes + bytes.length > maxCacheBytes && cache.size) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.bytes.length; cache.delete(oldest);
      }
      if (bytes.length <= maxCacheBytes) {
        cache.set(media.id, { bytes, contentType, expires: Date.now() + 5 * 60_000 });
        cacheBytes += bytes.length;
      }
      return { bytes, contentType };
    })();
    downloads.set(media.id, operation);
    try { return await operation; } finally { downloads.delete(media.id); }
  }

  app.get<{ Params: { id: string }; Querystring: { device?: string; expires?: string; ticket?: string } }>('/v1/media/:id', async (request, reply) => {
    const { device: deviceId, expires, ticket } = request.query;
    if (!deviceId || !expires || !ticket || !catalog.verify(request.params.id, deviceId, Number(expires), ticket)) return reply.code(401).send({ error: 'Lien expiré ou invalide.' });
    const device = store.getDevice(deviceId);
    const media = catalog.get(request.params.id);
    if (!device || !media || device.channelId !== media.channelId || !config.allowedChannelIds.has(device.channelId)) return reply.code(404).send({ error: 'Média indisponible.' });
    try {
      const { bytes, contentType } = await download(media);
      reply.header('Content-Type', contentType).header('Cache-Control', 'private, max-age=60').header('Accept-Ranges', 'bytes');
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = 0;
        let end = bytes.length - 1;
        if (!match || (!match[1] && !match[2])) return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send();
        if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send();
        return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start, end + 1));
      }
      return reply.send(bytes);
    } catch {
      return reply.code(502).send({ error: 'Le média ne peut pas être téléchargé.' });
    }
  });

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const socket of app.websocketServer.clients) socket.terminate();
    store.close();
  });

  return {
    app, store,
    publish(channelId, author, input) {
      if (!config.allowedChannelIds.has(channelId)) return false;
      const media = catalog.add(channelId, author, input);
      if (!media) return false;
      for (const [socket, device] of peers) if (device.channelId === channelId) send(socket, {
        type: 'media', id: media.id, channelId, kind: media.kind,
        ...(media.loop ? { loop: true } : {}),
        url: catalog.url(config.publicUrl, media.id, device.id), name: media.name, author: media.author, createdAt: media.createdAt,
      });
      return true;
    },
    publishStatus() { for (const socket of peers.keys()) send(socket, { type: 'status', discordConnected: discord.connected() }); },
  };
}
