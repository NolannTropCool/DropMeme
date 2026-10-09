import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Device { id: string; channelId: string; channelName: string; discordUserId?: string; discordUserName?: string }
interface DiscordColumns { discord_user_id: string | null; discord_user_name: string | null }
interface DeviceRow extends DiscordColumns { id: string; channel_id: string; channel_name: string }
interface PairRow extends DiscordColumns { channel_id: string; channel_name: string; expires_at: number }
const discordIdentity = (row: DiscordColumns) => ({ ...(row.discord_user_id ? { discordUserId: row.discord_user_id } : {}), ...(row.discord_user_name ? { discordUserName: row.discord_user_name } : {}) });
const deviceFromRow = (row: DeviceRow): Device => ({ id: row.id, channelId: row.channel_id, channelName: row.channel_name, ...discordIdentity(row) });
const deviceColumns = 'id, channel_id, channel_name, discord_user_id, discord_user_name';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(hash(left), 'hex'), Buffer.from(hash(right), 'hex'));
}

/** SQLite is the only persistent service; pairing codes and tokens are stored hashed. */
export class Store {
  private readonly db: DatabaseSync;
  readonly signingKey: Buffer;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, created_at INTEGER NOT NULL,
        discord_user_id TEXT, discord_user_name TEXT
      );
      CREATE TABLE IF NOT EXISTS pairing (
        code_hash TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL, expires_at INTEGER NOT NULL, discord_user_id TEXT, discord_user_name TEXT
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Columns added after 0.2 are created in place: existing tokens and invitations survive, initially unlinked.
    for (const table of ['devices', 'pairing']) {
      const columns = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
      for (const column of ['discord_user_id', 'discord_user_name']) if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    const existing = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('signing_key') as { value: string } | undefined;
    if (existing) this.signingKey = Buffer.from(existing.value, 'hex');
    else {
      this.signingKey = randomBytes(32);
      this.db.prepare('INSERT INTO metadata VALUES (?, ?)').run('signing_key', this.signingKey.toString('hex'));
    }
  }

  createPairing(channelId: string, channelName: string, now = Date.now(), discordUserId?: string, discordUserName?: string): string {
    this.db.prepare('DELETE FROM pairing WHERE expires_at <= ?').run(now);
    // Multiple users can pair in parallel; keep at most 100 live invitations per channel.
    this.db.prepare(`DELETE FROM pairing WHERE channel_id = ? AND code_hash NOT IN (
      SELECT code_hash FROM pairing WHERE channel_id = ? ORDER BY expires_at DESC LIMIT 99
    )`).run(channelId, channelId);
    const code = `${randomBytes(4).toString('hex')}-${randomBytes(4).toString('hex')}`.toUpperCase();
    this.db.prepare('INSERT INTO pairing (code_hash, channel_id, channel_name, expires_at, discord_user_id, discord_user_name) VALUES (?, ?, ?, ?, ?, ?)').run(hash(code), channelId, channelName, now + 10 * 60_000, discordUserId ?? null, discordUserId ? discordUserName ?? null : null);
    return code;
  }

  consumePairing(code: string, now = Date.now()): Omit<Device, 'id'> | undefined {
    const row = this.db.prepare('DELETE FROM pairing WHERE code_hash = ? RETURNING *').get(hash(code)) as PairRow | undefined;
    if (!row || row.expires_at <= now) return undefined;
    return { channelId: row.channel_id, channelName: row.channel_name, ...discordIdentity(row) };
  }

  createDevice(channelId: string, channelName: string, discordUserId?: string, discordUserName?: string): Device & { token: string } {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const identity = { discord_user_id: discordUserId ?? null, discord_user_name: discordUserId ? discordUserName ?? null : null };
    this.db.prepare('INSERT INTO devices (id, token_hash, channel_id, channel_name, created_at, discord_user_id, discord_user_name) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, hash(token), channelId, channelName, Date.now(), identity.discord_user_id, identity.discord_user_name);
    return { id, token, channelId, channelName, ...discordIdentity(identity) };
  }

  authenticate(token: string): Device | undefined {
    const row = this.db.prepare(`SELECT ${deviceColumns} FROM devices WHERE token_hash = ?`).get(hash(token)) as DeviceRow | undefined;
    return row && deviceFromRow(row);
  }

  getDevice(id: string): Device | undefined {
    const row = this.db.prepare(`SELECT ${deviceColumns} FROM devices WHERE id = ?`).get(id) as DeviceRow | undefined;
    return row && deviceFromRow(row);
  }

  /** Only a fresh private Discord code from this channel can establish an identity. */
  linkDevice(id: string, code: string, now = Date.now()): Device | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const device = this.getDevice(id);
      const invitation = device ? this.db.prepare(`DELETE FROM pairing
        WHERE code_hash = ? AND channel_id = ? AND discord_user_id IS NOT NULL AND expires_at > ?
        RETURNING *`).get(hash(code), device.channelId, now) as PairRow | undefined : undefined;
      if (device && invitation?.discord_user_id) this.db.prepare('UPDATE devices SET discord_user_id = ?, discord_user_name = ? WHERE id = ?').run(invitation.discord_user_id, invitation.discord_user_name, id);
      this.db.exec('COMMIT');
      return device && invitation?.discord_user_id ? this.getDevice(id) : undefined;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  revoke(id: string): void { this.db.prepare('DELETE FROM devices WHERE id = ?').run(id); }
  deviceCount(): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM devices').get() as { count: number }).count; }
  close(): void { this.db.close(); }
}
