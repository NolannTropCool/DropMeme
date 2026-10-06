import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { MediaKind } from '@dropmeme/shared';
import { equalSecret } from './store.js';

const types = new Map<string, MediaKind>([
  ['image/png', 'image'], ['image/jpeg', 'image'], ['image/gif', 'image'],
  ['image/webp', 'image'], ['image/avif', 'image'],
  ['video/mp4', 'video'], ['video/webm', 'video'],
  ['video/quicktime', 'video'],
  ['audio/mpeg', 'audio'], ['audio/ogg', 'audio'], ['audio/wav', 'audio'],
  ['audio/x-wav', 'audio'], ['audio/mp4', 'audio'], ['audio/webm', 'audio'],
]);
const extensions: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mov: 'video/quicktime',
};

export interface IncomingMedia { url: string; name: string; contentType: string | null; size: number; sourceId?: string; loop?: boolean }
export interface StoredMedia extends IncomingMedia {
  id: string; channelId: string; kind: MediaKind; author: string; createdAt: number;
  bytes?: Buffer; text?: string; targetDeviceId?: string; animation?: boolean;
}

/** Only exact HTTPS media CDN hosts. Never fetch a message's arbitrary URL or an HTML player. */
export function isDiscordMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (url.hostname === 'media.tenor.com') return /^\/[A-Za-z0-9_-]+\/[^/]+\.(gif|mp4|webm|webp)$/i.test(url.pathname);
    return ['cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net'].includes(url.hostname) &&
      (url.pathname.startsWith('/attachments/') || url.pathname.startsWith('/external/'));
  } catch { return false; }
}

export function classifyMedia(media: IncomingMedia, maxBytes: number): MediaKind | undefined {
  if (!isDiscordMediaUrl(media.url) || media.size < 0 || media.size > maxBytes) return undefined;
  const contentType = media.contentType?.split(';')[0]?.toLowerCase();
  if (contentType && !(contentType === 'application/octet-stream' && /\.mov$/i.test(media.name))) return types.get(contentType);
  return types.get(extensions[media.name.toLowerCase().split('.').at(-1) ?? ''] ?? '');
}

export class MediaCatalog {
  private readonly entries = new Map<string, StoredMedia>();
  constructor(private readonly key: Buffer, private readonly maxBytes: number) {}

  add(channelId: string, author: string, input: IncomingMedia, now = Date.now()): StoredMedia | undefined {
    this.prune(now);
    const kind = classifyMedia(input, this.maxBytes);
    if (!kind) return undefined;
    const id = input.sourceId ? createHash('sha256').update(`${channelId}:${input.sourceId}`).digest('hex') : randomUUID();
    if (this.entries.has(id)) return undefined;
    const media: StoredMedia = { ...input, name: input.name.slice(0, 256), id, channelId, author: author.slice(0, 100), kind, createdAt: now, animation: input.loop === true || input.contentType === 'image/gif' || /\.(gif|webp)$/i.test(input.name) };
    this.insert(media);
    return media;
  }

  addUpload(channelId: string, author: string, bytes: Buffer, name: string, contentType: string, targetDeviceId?: string): StoredMedia | undefined {
    this.prune(Date.now());
    const kind = types.get(contentType);
    if (!kind || !bytes.length || bytes.length > Math.min(this.maxBytes, 64 * 1024 * 1024)) return undefined;
    const id = randomUUID();
    const media: StoredMedia = { id, channelId, author: author.slice(0, 100), kind, bytes, name: name.slice(0, 256), contentType, size: bytes.length, url: `upload:${id}`, createdAt: Date.now(), animation: contentType === 'image/gif' || (contentType === 'image/webp' && bytes.includes(Buffer.from('ANIM'))), ...(targetDeviceId ? { targetDeviceId } : {}) };
    this.insert(media); return media;
  }

  addText(channelId: string, author: string, text: string, targetDeviceId?: string, sourceId?: string): StoredMedia | undefined {
    this.prune(Date.now());
    if (!text.trim() || text.length > 2000) return undefined;
    const id = sourceId ? createHash('sha256').update(`${channelId}:${sourceId}`).digest('hex') : randomUUID();
    if (this.entries.has(id)) return undefined;
    const media: StoredMedia = { id, channelId, author: author.slice(0, 100), kind: 'text', text, name: 'Message', contentType: 'text/plain', size: Buffer.byteLength(text), url: `text:${id}`, createdAt: Date.now(), ...(targetDeviceId ? { targetDeviceId } : {}), ...(sourceId ? { sourceId } : {}) };
    this.insert(media); return media;
  }

  private insert(media: StoredMedia): void {
    this.entries.set(media.id, media);
    let bytes = [...this.entries.values()].reduce((total, value) => total + (value.bytes?.length ?? 0), 0);
    for (const [id, value] of this.entries) {
      if (this.entries.size <= 500 && bytes <= 64 * 1024 * 1024) break;
      bytes -= value.bytes?.length ?? 0; this.entries.delete(id);
    }
  }

  /** Forgets every media of a deleted Discord message: its tickets stop resolving. */
  retract(channelId: string, messageId: string): string[] {
    const ids = [...this.entries.values()].filter(media => media.channelId === channelId && media.sourceId?.startsWith(`${messageId}:`)).map(media => media.id);
    for (const id of ids) this.entries.delete(id);
    return ids;
  }

  get(id: string, now = Date.now()): StoredMedia | undefined {
    this.prune(now);
    return this.entries.get(id);
  }

  private prune(now: number): void {
    for (const [id, media] of this.entries) if (now - media.createdAt > 30 * 60_000) this.entries.delete(id);
  }

  private signature(id: string, deviceId: string, expires: number): string {
    return createHmac('sha256', this.key).update(`${id}:${deviceId}:${expires}`).digest('base64url');
  }

  url(origin: string, id: string, deviceId: string, now = Date.now()): string {
    const expires = now + 30 * 60_000;
    const params = new URLSearchParams({ device: deviceId, expires: String(expires), ticket: this.signature(id, deviceId, expires) });
    return `${origin}/v1/media/${id}?${params}`;
  }

  verify(id: string, deviceId: string, expires: number, ticket: string, now = Date.now()): boolean {
    return Number.isSafeInteger(expires) && expires > now && expires <= now + 30 * 60_000 &&
      equalSecret(ticket, this.signature(id, deviceId, expires));
  }
}
