import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { appVersion, pairingRequestSchema, deviceLinkRequestSchema, profileSchema, textRequestSchema, type ServerEvent, type Profile } from '@dropmeme/shared';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import { Store, equalSecret, type Device } from './store.js';
import { MediaCatalog, classifyMedia, type IncomingMedia, type StoredMedia } from './media.js';
import { convertMov, sniffContentType } from './convert.js';
import { displayText } from './discord-content.js';

export interface DiscordBridge {
  connected(): boolean;
  channelName(id: string): Promise<string | undefined>;
}
export interface Application {
  app: FastifyInstance;
  store: Store;
  publish(channelId: string, author: string, input: IncomingMedia, recipientDiscordIds?: readonly string[]): boolean;
  publishStatus(): void;
  publishText(channelId: string, author: string, text: string, sourceId?: string, recipientDiscordIds?: readonly string[]): boolean;
}
const origins = new Set(['tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost', 'http://localhost:1420']);
const authenticateSchema = z.object({ type: z.literal('authenticate'), token: z.string().min(32).max(128), profile: profileSchema.optional(), protocol: z.number().int().min(1).max(2).optional(), version: z.string().max(32).optional() }).strict();
const updateProfileSchema = z.object({ type: z.literal('profile'), profile: profileSchema }).strict();
interface ConnectedDevice extends Device { profile: Profile; protocol: number; version: string }

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
  const peers = new Map<WebSocket, ConnectedDevice>();
  const sendTimes = new Map<string, number[]>();
  const profileTimes = new WeakMap<WebSocket, number[]>();
  const cache = new Map<string, { bytes: Buffer; contentType: string; expires: number }>();
  const downloads = new Map<string, Promise<{ bytes: Buffer; contentType: string }>>();
  let cacheBytes = 0;
  const maxCacheBytes = 64 * 1024 * 1024;
  const fetchMedia = options.fetchMedia ?? fetch;

  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || origins.has(origin)), methods: ['GET', 'POST', 'DELETE'] });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 2048 } });
  await app.register(multipart, { limits: { fileSize: config.maxMediaBytes, files: 1, fields: 1, fieldSize: 8_000, parts: 2 } });
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

  const publishPresence = (channelId: string) => {
    const connected = [...peers.entries()].filter(([socket, device]) => device.channelId === channelId && socket.readyState === 1);
    const list = connected.map(([, device]) => ({ id: device.id, name: device.profile.name, acceptDirect: device.profile.acceptDirect && device.protocol >= 2, version: device.version }));
    for (const [socket, device] of connected) if (device.protocol >= 2) send(socket, { type: 'presence', peers: list });
  };
  const dispatch = (media: StoredMedia) => {
    for (const [socket, device] of peers) if (device.channelId === media.channelId && (!media.targetDeviceId || media.targetDeviceId === device.id) && (media.targetDeviceIds === undefined || media.targetDeviceIds.includes(device.id)) && (media.kind !== 'text' || device.protocol >= 2)) send(socket, {
      type: 'media', id: media.id, channelId: media.channelId, kind: media.kind,
      ...(media.loop ? { loop: true } : {}), ...(media.animation !== undefined ? { animation: media.animation } : {}), ...(media.text ? { text: media.text } : {}),
      ...(media.caption ? { caption: media.caption } : {}),
      url: catalog.url(config.publicUrl, media.id, device.id), name: media.name, author: media.author, createdAt: media.createdAt,
    });
  };
  const identity = (device: Device) => ({ ...(device.discordUserId ? { discordUserId: device.discordUserId } : {}), ...(device.discordUserName ? { discordUserName: device.discordUserName } : {}) });
  const sendReady = (socket: WebSocket, device: Device) => send(socket, { type: 'ready', channelId: device.channelId, channelName: device.channelName, discordConnected: discord.connected(), protocol: 2, version: appVersion, ...identity(device) });
  const mentionedDevices = (channelId: string, userIds: readonly string[] | undefined): string[] | undefined => {
    if (userIds === undefined) return undefined;
    const mentioned = new Set(userIds);
    return [...peers.entries()].filter(([socket, peer]) => socket.readyState === 1 && peer.channelId === channelId && peer.protocol >= 2 && peer.profile.acceptDirect && peer.discordUserId && mentioned.has(peer.discordUserId)).map(([, peer]) => peer.id);
  };
  const activeSender = (authorization: string | undefined) => {
    const device = authorization?.startsWith('Bearer ') ? store.authenticate(authorization.slice(7)) : undefined;
    return device && config.allowedChannelIds.has(device.channelId) ? [...peers.entries()].find(([socket, peer]) => socket.readyState === 1 && peer.id === device.id && peer.protocol >= 2)?.[1] : undefined;
  };
  const targetAllowed = (sender: ConnectedDevice, recipientId: string | undefined) => !recipientId || [...peers.entries()].some(([socket, peer]) => socket.readyState === 1 && peer.id === recipientId && peer.channelId === sender.channelId && peer.protocol >= 2 && peer.profile.acceptDirect);
  const reserveSend = (deviceId: string) => {
    for (const [id, times] of sendTimes) if (!times.some(time => Date.now() - time < 60_000)) sendTimes.delete(id);
    const times = (sendTimes.get(deviceId) ?? []).filter(time => Date.now() - time < 60_000);
    if (times.length >= 20) return false;
    times.push(Date.now()); sendTimes.set(deviceId, times); return true;
  };

  app.post('/v2/device/link', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const sender = activeSender(request.headers.authorization);
    if (!sender) return reply.code(401).send({ error: 'Connectez cet appareil au salon avant de le lier.' });
    const body = deviceLinkRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Code invalide. Utilisez le code privé de /dropmeme.' });
    const device = store.linkDevice(sender.id, body.data.code);
    if (!device?.discordUserId) return reply.code(401).send({ error: 'Code expiré, déjà utilisé ou généré dans un autre salon. Relancez /dropmeme dans ce salon.' });
    for (const [socket, peer] of peers) if (peer.id === device.id) { const linked = { ...device, profile: peer.profile, protocol: peer.protocol, version: peer.version }; peers.set(socket, linked); sendReady(socket, linked); }
    return reply.header('Cache-Control', 'no-store').send(identity(device));
  });

  app.post('/v2/send/text', { bodyLimit: 12_000 }, async (request, reply) => {
    const sender = activeSender(request.headers.authorization);
    if (!sender) return reply.code(401).send({ error: 'Connectez cet appareil au salon avant d’envoyer.' });
    const body = textRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Message ou destinataire invalide.' });
    if (!targetAllowed(sender, body.data.recipientId)) return reply.code(403).send({ error: 'Cette personne est déconnectée ou refuse les envois directs.' });
    if (!reserveSend(sender.id)) return reply.code(429).send({ error: 'Limite de 20 envois par minute atteinte.' });
    const media = catalog.addText(sender.channelId, sender.profile.name, body.data.text, body.data.recipientId);
    if (!media) return reply.code(400).send({ error: 'Texte invalide.' });
    dispatch(media); return reply.code(201).send({ id: media.id });
  });

  app.post<{ Querystring: { recipientId?: string } }>('/v2/send/file', { bodyLimit: config.maxMediaBytes + 8192 }, async (request, reply) => {
    const sender = activeSender(request.headers.authorization);
    if (!sender) return reply.code(401).send({ error: 'Connectez cet appareil au salon avant d’envoyer.' });
    const target = request.query.recipientId;
    if (target && !z.string().uuid().safeParse(target).success) return reply.code(400).send({ error: 'Destinataire invalide.' });
    if (!targetAllowed(sender, target)) return reply.code(403).send({ error: 'Cette personne est déconnectée ou refuse les envois directs.' });
    if (!reserveSend(sender.id)) return reply.code(429).send({ error: 'Limite de 20 envois par minute atteinte.' });
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'Choisissez un fichier.' });
    let bytes = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: 'Fichier trop volumineux.' });
    if (Object.keys(file.fields).some(name => name !== file.fieldname && name !== 'caption')) return reply.code(400).send({ error: 'Champ de fichier invalide.' });
    const field = file.fields.caption;
    let caption: string | undefined;
    if (field) {
      if (Array.isArray(field) || field.type !== 'field' || field.valueTruncated || !z.string().max(2000).safeParse(field.value).success) return reply.code(400).send({ error: 'Le texte d’accompagnement est limité à 2000 caractères.' });
      caption = displayText(field.value as string) || undefined;
    }
    let contentType = sniffContentType(bytes, file.filename);
    if (!contentType) return reply.code(415).send({ error: 'Format refusé. Utilisez une image, un GIF, WebP, MP4, WebM ou MOV.' });
    let name = file.filename.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 256);
    if (contentType === 'video/quicktime') {
      try { const converted = await convertMov(bytes, config.maxMediaBytes); bytes = converted.bytes; contentType = converted.contentType; name = name.replace(/\.mov$/i, '') + '.mp4'; }
      catch { return reply.code(422).send({ error: 'Conversion MOV impossible ou trop longue. Réessayez avec un fichier plus court.' }); }
    }
    // Consent/connection may have changed while the file was uploading or converting.
    const current = activeSender(request.headers.authorization);
    if (!current || !targetAllowed(current, target)) return reply.code(403).send({ error: 'L’envoi n’est plus autorisé.' });
    const media = catalog.addUpload(sender.channelId, sender.profile.name, bytes, name, contentType, target, caption);
    if (!media) return reply.code(413).send({ error: 'Fichier trop volumineux.' });
    dispatch(media); return reply.code(201).send({ id: media.id });
  });

  app.get('/healthz', async () => ({ ok: true, discordConnected: discord.connected() }));
  app.get('/readyz', async (_request, reply) => {
    return reply.code(discord.connected() ? 200 : 503).send({ ok: discord.connected() });
  });

  app.post('/v1/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = pairingRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Code ou ID de salon invalide.' });
    if (store.deviceCount() >= config.maxClients) return reply.code(503).send({ error: 'Nombre maximal d’appareils atteint.' });
    let subscription: Omit<Device, 'id'> | undefined;
    if ('code' in parsed.data) subscription = store.consumePairing(parsed.data.code);
    else if (config.joinKey && equalSecret(parsed.data.joinKey, config.joinKey) && config.allowedChannelIds.has(parsed.data.channelId)) {
      const channelName = await discord.channelName(parsed.data.channelId);
      if (channelName) subscription = { channelId: parsed.data.channelId, channelName };
    }
    if (!subscription || !config.allowedChannelIds.has(subscription.channelId)) {
      return reply.code(401).send({ error: 'Invitation invalide, expirée ou salon non autorisé.' });
    }
    const device = store.createDevice(subscription.channelId, subscription.channelName, subscription.discordUserId, subscription.discordUserName);
    return reply.code(201).header('Cache-Control', 'no-store').send({ token: device.token, deviceId: device.id, channelId: device.channelId, channelName: device.channelName, ...identity(device) });
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
    socket.on('close', () => { clearTimeout(timeout); const peer = peers.get(socket); peers.delete(socket); if (peer) publishPresence(peer.channelId); });
    socket.on('message', (data, binary) => {
      if (binary) { socket.close(1008, 'Message invalide'); return; }
      try {
        const body: unknown = JSON.parse(data.toString());
        const current = peers.get(socket);
        if (current) {
          const profile = updateProfileSchema.safeParse(body);
          if (!profile.success || current.protocol < 2) { socket.close(1008, 'Message invalide'); return; }
          const times = (profileTimes.get(socket) ?? []).filter(time => Date.now() - time < 60_000);
          if (times.length >= 30) { socket.close(1008, 'Trop de modifications de profil'); return; }
          times.push(Date.now()); profileTimes.set(socket, times);
          current.profile = profile.data.profile; publishPresence(current.channelId); return;
        }
        const parsed = authenticateSchema.safeParse(body);
        const device = parsed.success ? store.authenticate(parsed.data.token) : undefined;
        if (!device || !config.allowedChannelIds.has(device.channelId)) { socket.close(4001, 'Abonnement invalide'); return; }
        if ([...peers.values()].some(peer => peer.id === device.id)) { socket.close(4009, 'Appareil déjà connecté'); return; }
        clearTimeout(timeout);
        peers.set(socket, { ...device, profile: parsed.success && parsed.data.profile ? parsed.data.profile : { name: `Appareil ${device.id.slice(0, 6)}`, acceptDirect: false }, protocol: parsed.success ? parsed.data.protocol ?? 1 : 1, version: parsed.success ? parsed.data.version ?? '0.1' : '0.1' });
        sendReady(socket, device);
        publishPresence(device.channelId);
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
    if (media.text) return { bytes: Buffer.from(media.text), contentType: 'text/plain; charset=utf-8' };
    if (media.bytes) return { bytes: media.bytes, contentType: media.contentType! };
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
      let bytes: Buffer = Buffer.concat(chunks);
      if (!bytes.length) throw new Error('Média vide');
      let outputType = contentType;
      if (contentType === 'video/quicktime' || /\.mov$/i.test(media.name)) {
        const converted = await convertMov(bytes, config.maxMediaBytes); bytes = converted.bytes; outputType = converted.contentType;
      }
      while (cacheBytes + bytes.length > maxCacheBytes && cache.size) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.bytes.length; cache.delete(oldest);
      }
      if (bytes.length <= maxCacheBytes) {
        cache.set(media.id, { bytes, contentType: outputType, expires: Date.now() + 5 * 60_000 });
        cacheBytes += bytes.length;
      }
      return { bytes, contentType: outputType };
    })();
    downloads.set(media.id, operation);
    try { return await operation; } finally { downloads.delete(media.id); }
  }

  app.get<{ Params: { id: string }; Querystring: { device?: string; expires?: string; ticket?: string } }>('/v1/media/:id', async (request, reply) => {
    const { device: deviceId, expires, ticket } = request.query;
    if (!deviceId || !expires || !ticket || !catalog.verify(request.params.id, deviceId, Number(expires), ticket)) return reply.code(401).send({ error: 'Lien expiré ou invalide.' });
    const device = store.getDevice(deviceId);
    const media = catalog.get(request.params.id);
    if (!device || !media || device.channelId !== media.channelId || (media.targetDeviceId && media.targetDeviceId !== device.id) || (media.targetDeviceIds !== undefined && !media.targetDeviceIds.includes(device.id)) || !config.allowedChannelIds.has(device.channelId)) return reply.code(404).send({ error: 'Média indisponible.' });
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
    publish(channelId, author, input, recipientDiscordIds) {
      if (!config.allowedChannelIds.has(channelId)) return false;
      const media = catalog.add(channelId, author, input, Date.now(), mentionedDevices(channelId, recipientDiscordIds));
      if (!media) return false;
      dispatch(media);
      return true;
    },
    publishText(channelId, author, text, sourceId, recipientDiscordIds) {
      if (!config.allowedChannelIds.has(channelId)) return false;
      const media = catalog.addText(channelId, author, text, undefined, sourceId, mentionedDevices(channelId, recipientDiscordIds));
      if (!media) return false;
      dispatch(media); return true;
    },
    publishStatus() { for (const socket of peers.keys()) send(socket, { type: 'status', discordConnected: discord.connected() }); },
  };
}
