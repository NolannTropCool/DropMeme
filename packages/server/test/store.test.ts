import { describe, expect, test } from 'vitest';
import { Store, equalSecret } from '../src/store.js';

describe('device credentials', () => {
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
