import { describe, expect, test } from 'vitest';
import { Store, equalSecret } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('device credentials', () => {
  test('0.2 database migration preserves credentials, invitations and the signing key across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dropmeme-migration-')); const path = join(dir, 'devices.sqlite');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE pairing (code_hash TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, expires_at INTEGER NOT NULL); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    old.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run('old-device', hash('old-token'), '123456789012345678', 'memes', 1);
    old.prepare('INSERT INTO pairing VALUES (?, ?, ?, ?)').run(hash('AAAAAAAA-BBBBBBBB'), '123456789012345678', 'memes', Date.now() + 60_000);
    old.prepare('INSERT INTO metadata VALUES (?, ?)').run('signing_key', 'ab'.repeat(32)); old.close();
    try {
      for (let i = 0; i < 2; i++) {
        const store = new Store(path);
        try {
          expect(store.authenticate('old-token')).toEqual({ id: 'old-device', channelId: '123456789012345678', channelName: 'memes' });
          expect(store.signingKey.toString('hex')).toBe('ab'.repeat(32));
          if (i === 1) expect(store.consumePairing('AAAAAAAA-BBBBBBBB')).toEqual({ channelId: '123456789012345678', channelName: 'memes' });
        } finally { store.close(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('linking requires a fresh identity code in the same channel and keeps the existing token', () => {
    const store = new Store(':memory:');
    try {
      const device = store.createDevice('123456789012345678', 'memes');
      const other = store.createDevice('223456789012345678', 'other');
      const code = store.createPairing(device.channelId, 'memes', 1000, '323456789012345678');
      expect(store.linkDevice(other.id, code, 2000)).toBeUndefined();
      expect(store.linkDevice(device.id, code, 2000)?.discordUserId).toBe('323456789012345678');
      expect(store.authenticate(device.token)?.discordUserId).toBe('323456789012345678');
      expect(store.linkDevice(device.id, code, 2000)).toBeUndefined();
      const expired = store.createPairing(device.channelId, 'memes', 1000, '423456789012345678');
      expect(store.linkDevice(device.id, expired, 601000)).toBeUndefined();
      const legacy = store.createPairing(device.channelId, 'memes', 1000);
      expect(store.linkDevice(device.id, legacy, 2000)).toBeUndefined();
      expect(store.consumePairing(legacy, 2000)).toBeDefined();
      expect(store.authenticate(device.token)?.discordUserId).toBe('323456789012345678');
    } finally { store.close(); }
  });
  test('pairing is short-lived, single-use and supports concurrent invitations', () => {
    const store = new Store(':memory:');
    try {
      const old = store.createPairing('123456789012345678', 'memes', 1000);
      const code = store.createPairing('123456789012345678', 'memes', 2000);
      expect(store.consumePairing(old, 3000)).toEqual({ channelId: '123456789012345678', channelName: 'memes' });
      expect(store.consumePairing(code, 3000)).toEqual({ channelId: '123456789012345678', channelName: 'memes' });
      expect(store.consumePairing(code, 3000)).toBeUndefined();
      const expired = store.createPairing('123456789012345678', 'memes', 4000);
      expect(store.consumePairing(expired, 604000)).toBeUndefined();
    } finally { store.close(); }
  });
  test('tokens authenticate only their device and can be revoked', () => {
    const store = new Store(':memory:');
    try {
      const device = store.createDevice('123456789012345678', 'memes');
      expect(store.authenticate(device.token)?.id).toBe(device.id);
      expect(store.authenticate('invalid')).toBeUndefined();
      store.revoke(device.id);
      expect(store.authenticate(device.token)).toBeUndefined();
    } finally { store.close(); }
  });
  test('secret comparison handles unequal lengths without throwing', () => {
    expect(equalSecret('abc', 'abc')).toBe(true);
    expect(equalSecret('abc', 'abcd')).toBe(false);
  });
});
