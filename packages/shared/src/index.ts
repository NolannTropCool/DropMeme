import { z } from 'zod';

export const snowflake = z.string().regex(/^\d{17,20}$/, 'ID Discord invalide');
export const appVersion = '0.2.0';
export const protocolVersion = 2;
export const mediaKind = z.enum(['image', 'video', 'audio', 'text']);
export type MediaKind = z.infer<typeof mediaKind>;

const positionSchema = z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'custom']);
const layoutSchema = z.object({
  position: positionSchema.default('custom'),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().int().min(160).max(8192), height: z.number().int().min(120).max(4320),
});
export const zoneSchema = layoutSchema.extend({ id: z.string().min(1).max(100), monitor: z.string().min(1).max(200) });
export type DisplayZone = z.infer<typeof zoneSchema>;
export const profileSchema = z.object({ name: z.string().trim().min(1).max(64), acceptDirect: z.boolean() });
export type Profile = z.infer<typeof profileSchema>;
export const peerSchema = profileSchema.extend({ id: z.string(), version: z.string().max(32) });
export type Peer = z.infer<typeof peerSchema>;
export const settingsSchema = z.object({
  monitor: z.string().default('primary'),
  position: positionSchema.default('bottom-right'),
  customX: z.number().min(0).max(1).default(1),
  customY: z.number().min(0).max(1).default(1),
  layouts: z.record(z.string(), layoutSchema).default({}),
  width: z.number().int().min(160).max(8192).default(480),
  height: z.number().int().min(120).max(4320).default(320),
  durationSeconds: z.number().int().min(2).max(120).default(10),
  gifDurationSeconds: z.number().int().min(2).max(120).default(10),
  videoDurationSeconds: z.number().int().min(2).max(120).default(30),
  displayName: z.string().trim().min(1).max(64).default('Utilisateur'),
  acceptDirect: z.boolean().default(false),
  showAuthor: z.boolean().default(true),
  texts: z.boolean().default(true),
  multiDisplay: z.boolean().default(false),
  maxSimultaneous: z.number().int().min(2).max(8).default(4),
  multiPlacement: z.enum(['random', 'zones']).default('random'),
  zones: z.array(zoneSchema).max(8).default([]),
  volume: z.number().int().min(0).max(100).default(50),
  sound: z.boolean().default(false),
  opacity: z.number().int().min(20).max(100).default(100),
  images: z.boolean().default(true),
  videos: z.boolean().default(true),
  audio: z.boolean().default(false),
  maxQueue: z.number().int().min(1).max(30).default(10),
  startMinimized: z.boolean().default(false),
  quickSendShortcut: z.string().trim().min(1).max(100).default('CommandOrControl+Shift+Space'),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});

export const mediaEventSchema = z.object({
  type: z.literal('media'),
  id: z.string().min(1).max(100),
  channelId: snowflake,
  kind: mediaKind,
  loop: z.boolean().optional(),
  animation: z.boolean().optional(),
  text: z.string().min(1).max(2000).optional(),
  url: z.url(),
  name: z.string().max(256),
  author: z.string().max(100),
  createdAt: z.number(),
}).refine(value => value.kind !== 'text' || !!value.text, { message: 'Le texte est obligatoire.' });
export type MediaEvent = z.infer<typeof mediaEventSchema>;

export const serverEventSchema = z.discriminatedUnion('type', [
  mediaEventSchema,
  // No protocol bump: 0.2 clients drop unknown events, while a 0.2 server rejects protocol 3 logins.
  z.object({ type: z.literal('retract'), ids: z.array(z.string().min(1).max(100)).min(1).max(2000) }),
  z.object({ type: z.literal('ready'), channelId: snowflake, channelName: z.string(), discordConnected: z.boolean(), protocol: z.number().optional(), version: z.string().optional(), gifSearch: z.boolean().optional() }),
  z.object({ type: z.literal('presence'), peers: z.array(peerSchema).max(1000) }),
  z.object({ type: z.literal('status'), discordConnected: z.boolean() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export const textRequestSchema = z.object({ text: z.string().trim().min(1).max(2000), recipientId: z.string().uuid().optional() }).strict();
/** Quick-send webview to main webview. Always the whole channel. GIF, file and favorite kinds join this union. */
export const quickSendRequestSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().uuid(), kind: z.literal('text'), text: textRequestSchema.shape.text }).strict(),
]);
export type QuickSendRequest = z.infer<typeof quickSendRequestSchema>;
export const gifId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const gifSearchRequestSchema = z.object({ q: z.string().trim().min(2).max(100), page: z.coerce.number().int().min(1).max(20).default(1) });
export const gifRequestSchema = z.object({ id: gifId, recipientId: z.string().uuid().optional() }).strict();
const httpsUrl = z.url({ protocol: /^https$/ });
export const gifResultSchema = z.object({ id: gifId, previewUrl: httpsUrl, url: httpsUrl, width: z.number().int().positive(), height: z.number().int().positive() });
export type GifResult = z.infer<typeof gifResultSchema>;
export const gifSearchResponseSchema = z.object({ results: z.array(gifResultSchema).max(50), hasNext: z.boolean() });
export type GifSearchResponse = z.infer<typeof gifSearchResponseSchema>;
export function isAnimation(media: Pick<MediaEvent, 'kind' | 'name' | 'loop' | 'animation'>): boolean {
  if (media.animation !== undefined) return media.animation;
  return media.animation === true || (media.kind === 'video' && media.loop === true) || (media.kind === 'image' && /\.(gif|webp)$/i.test(media.name));
}
export function playbackDuration(media: MediaEvent, settings: Settings): number {
  return isAnimation(media) ? settings.gifDurationSeconds : media.kind === 'video' ? settings.videoDurationSeconds : settings.durationSeconds;
}

export const pairingRequestSchema = z.union([
  z.object({ code: z.string().regex(/^[A-Z0-9]{8}-[A-Z0-9]{8}$/) }).strict(),
  z.object({ channelId: snowflake, joinKey: z.string().min(24).max(256) }).strict(),
]);
export const pairingResponseSchema = z.object({
  token: z.string().min(32),
  deviceId: z.string(),
  channelId: snowflake,
  channelName: z.string(),
});
export type PairingResponse = z.infer<typeof pairingResponseSchema>;

/** Every request must derive from the user's server, never from a Discord message. */
export function normalizeServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Utilisez uniquement une adresse de serveur, sans chemin ni identifiants.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('HTTPS est obligatoire, sauf pour localhost.');
  }
  return url.origin;
}
