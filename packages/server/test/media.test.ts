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
    'http://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.mp4',
    'https://static.klipy.com.evil.example/ii/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.mp4',
    'https://static3.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.mp4',
    'https://api.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.mp4',
    'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.mp4?redirect=1',
    'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/page.html',
    'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/La0HaAzw.mp4',
    'https://static.klipy.com/other/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.mp4',
    'https://static.klipy.com:8443/ii/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.mp4',
  ])('rejects untrusted URL %s', url => { expect(isDiscordMediaUrl(url)).toBe(false); });
  test.each(['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com'])('accepts Klipy CDN media on %s', host => {
    for (const extension of ['mp4', 'webp', 'gif', 'webm']) expect(isDiscordMediaUrl(`https://${host}/ii/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.${extension}`)).toBe(true);
  });
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
