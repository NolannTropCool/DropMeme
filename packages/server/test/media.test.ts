import { describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { classifyMedia, isDiscordMediaUrl, MediaCatalog } from '../src/media.js';

const valid = 'https://cdn.discordapp.com/attachments/123/456/test.png';
describe('media safety', () => {
  test.each([
    'http://cdn.discordapp.com/attachments/a.png',
    'https://cdn.discordapp.com.evil.example/attachments/a.png',
    'https://cdn.discordapp.com@127.0.0.1/attachments/a.png',
    'https://127.0.0.1/attachments/a.png',
    'file:///etc/passwd',
    'https://cdn.discordapp.com:8443/attachments/a.png',
    'https://cdn.discordapp.com/not-media/a.png',
    'https://media.tenor.com.evil.example/id/test.gif',
    'https://media.tenor.com/id/player.html',
    'https://tenor.com/view/cat-123',
    'https://images-ext-3.discordapp.net/external/test.gif',
  ])('rejects untrusted URL %s', url => { expect(isDiscordMediaUrl(url)).toBe(false); });
  test('only known types and bounded files are accepted', () => {
    expect(classifyMedia({ url: valid, name: 'image.png', contentType: 'image/png', size: 10 }, 100)).toBe('image');
    expect(classifyMedia({ url: valid, name: 'image.png', contentType: 'image/svg+xml', size: 10 }, 100)).toBeUndefined();
    expect(classifyMedia({ url: valid, name: 'image.png', contentType: 'text/html', size: 10 }, 100)).toBeUndefined();
    expect(classifyMedia({ url: valid, name: 'image.png', contentType: null, size: 101 }, 100)).toBeUndefined();
  });
  test('tickets bind media, device and expiry; catalog expires media', () => {
    const catalog = new MediaCatalog(randomBytes(32), 100);
    const media = catalog.add('123456789012345678', 'Alice', { url: valid, name: 'test.png', contentType: 'image/png', size: 10 }, 1000)!;
    const url = new URL(catalog.url('https://example.com', media.id, 'device-a', 1000));
    const expires = Number(url.searchParams.get('expires'));
    const ticket = url.searchParams.get('ticket')!;
    expect(catalog.verify(media.id, 'device-a', expires, ticket, 2000)).toBe(true);
    expect(catalog.verify(media.id, 'device-b', expires, ticket, 2000)).toBe(false);
    expect(catalog.verify('other-media', 'device-a', expires, ticket, 2000)).toBe(false);
    expect(catalog.verify(media.id, 'device-a', expires, ticket, expires)).toBe(false);
    expect(catalog.get(media.id, 1000 + 31 * 60_000)).toBeUndefined();
  });
  test('replayed Discord events do not generate duplicate media', () => {
    const catalog = new MediaCatalog(randomBytes(32), 100);
    const input = { url: valid, name: 'test.png', contentType: 'image/png', size: 10, sourceId: 'message:attachment' };
    expect(catalog.add('123456789012345678', 'Alice', input)).toBeDefined();
    expect(catalog.add('123456789012345678', 'Alice', input)).toBeUndefined();
    expect(catalog.add('223456789012345678', 'Alice', input)).toBeDefined();
  });
});
