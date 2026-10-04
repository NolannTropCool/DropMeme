import { z } from 'zod';

export const snowflake = z.string().regex(/^\d{17,20}$/, 'ID Discord invalide');
export const mediaKind = z.enum(['image', 'video', 'audio']);
export type MediaKind = z.infer<typeof mediaKind>;

export const settingsSchema = z.object({
  monitor: z.string().default('primary'),
  position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']).default('bottom-right'),
  width: z.number().int().min(160).max(1920).default(480),
  height: z.number().int().min(120).max(1080).default(320),
  durationSeconds: z.number().int().min(2).max(120).default(10),
  volume: z.number().int().min(0).max(100).default(50),
  sound: z.boolean().default(false),
  opacity: z.number().int().min(20).max(100).default(100),
  images: z.boolean().default(true),
  videos: z.boolean().default(true),
  audio: z.boolean().default(false),
  maxQueue: z.number().int().min(1).max(30).default(10),
  startMinimized: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});

export const mediaEventSchema = z.object({
  type: z.literal('media'),
  id: z.string().min(1).max(100),
  channelId: snowflake,
  kind: mediaKind,
  url: z.url(),
  name: z.string().max(256),
  author: z.string().max(100),
  createdAt: z.number(),
});
export type MediaEvent = z.infer<typeof mediaEventSchema>;

export const serverEventSchema = z.discriminatedUnion('type', [
  mediaEventSchema,
  z.object({ type: z.literal('ready'), channelId: snowflake, channelName: z.string(), discordConnected: z.boolean() }),
  z.object({ type: z.literal('status'), discordConnected: z.boolean() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

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
