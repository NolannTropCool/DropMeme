import { z } from 'zod';
import { normalizeServerUrl, snowflake } from '@dropmeme/shared';

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  ALLOWED_CHANNEL_IDS: z.string().min(1).transform(value => value.split(',').map(id => snowflake.parse(id.trim()))),
  PUBLIC_URL: z.string().transform(normalizeServerUrl),
  JOIN_KEY: z.string().min(24).max(256).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/dropmeme.sqlite'),
  MAX_MEDIA_MB: z.coerce.number().int().min(1).max(100).default(25),
  MAX_CLIENTS: z.coerce.number().int().min(1).max(1000).default(100),
});

export interface Config {
  discordToken: string;
  applicationId: string;
  guildId: string;
  allowedChannelIds: Set<string>;
  publicUrl: string;
  joinKey: string | undefined;
  port: number;
  host: string;
  databasePath: string;
  maxMediaBytes: number;
  maxClients: number;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Never include input values, particularly DISCORD_TOKEN, in diagnostics.
    throw new Error(`Configuration invalide : ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  const v = result.data;
  return {
    discordToken: v.DISCORD_TOKEN, applicationId: v.DISCORD_APPLICATION_ID,
    guildId: v.DISCORD_GUILD_ID, allowedChannelIds: new Set(v.ALLOWED_CHANNEL_IDS),
    publicUrl: v.PUBLIC_URL, joinKey: v.JOIN_KEY, port: v.PORT, host: v.HOST,
    databasePath: v.DATABASE_PATH, maxMediaBytes: v.MAX_MEDIA_MB * 1024 * 1024,
    maxClients: v.MAX_CLIENTS,
  };
}
