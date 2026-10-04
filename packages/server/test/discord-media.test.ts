import { expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { extractDiscordMedia, type MediaMessage } from '../src/discord-media.js';
import { MediaCatalog } from '../src/media.js';

const base: MediaMessage = { id: 'message', attachments: new Map(), embeds: [] };
test('extracts GIF attachments without flattening animation', () => {
  const file = { id: 'attachment', url: 'https://cdn.discordapp.com/attachments/1/2/animated.gif', name: 'animated.gif', contentType: 'image/gif', size: 10 };
  expect(extractDiscordMedia({ ...base, attachments: new Map([[file.id, file]]) })).toEqual([{ url: file.url, name: file.name, contentType: file.contentType, size: 10, sourceId: 'message:attachment' }]);
});
test('GIF picker unfurls arrive later, use actual animated media and deduplicate repeated updates', () => {
  const catalog = new MediaCatalog(randomBytes(32), 1024);
  expect(extractDiscordMedia(base)).toEqual([]);
  const updated = { ...base, embeds: [{ type: 'gifv', video: { url: 'https://media.tenor.com/abcAAAAC/cat.mp4' }, thumbnail: { proxyURL: 'https://images-ext-1.discordapp.net/external/token/cat.jpg' } }] };
  const media = extractDiscordMedia(updated)[0]!;
  expect(media).toMatchObject({ url: updated.embeds[0]!.video.url, name: 'animation.mp4', contentType: 'video/mp4', loop: true });
  expect(catalog.add('channel', 'Discord', media)?.kind).toBe('video');
  expect(catalog.add('channel', 'Discord', extractDiscordMedia(updated)[0]!)).toBeUndefined();
});
test('accepts Discord external image proxies but never forwards external HTML or YouTube players', () => {
  const media = extractDiscordMedia({ ...base, embeds: [
    { type: 'image', image: { proxyURL: 'https://images-ext-2.discordapp.net/external/token/test.gif' } },
    { type: 'gifv', video: { url: 'https://tenor.com/view/cat-123' } },
    { type: 'video', video: { url: 'https://youtube.com/watch?v=test' } },
    { image: { url: 'https://127.0.0.1/private.png' } },
  ] });
  expect(media).toHaveLength(1);
  expect(media[0]?.url).toContain('images-ext-2.discordapp.net');
});
test('uses an animated GIF thumbnail only when no video is provided, never a static poster', () => {
  expect(extractDiscordMedia({ ...base, embeds: [
    { type: 'gifv', thumbnail: { url: 'https://media.tenor.com/id/animation.gif' } },
    { type: 'gifv', thumbnail: { proxyURL: 'https://images-ext-1.discordapp.net/external/id/poster.jpg' } },
  ] })).toEqual([expect.objectContaining({ name: 'animation.gif', url: 'https://media.tenor.com/id/animation.gif' })]);
});
