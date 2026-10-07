import { expect, test } from 'vitest';
import { EmbedType } from 'discord.js';
import { makeEmbed } from './discord-fixtures.js';
import { randomBytes } from 'node:crypto';
import { extractDiscordMedia, type MediaMessage } from '../src/discord-media.js';
import { MediaCatalog } from '../src/media.js';

const base: MediaMessage = { id: 'message', attachments: new Map(), embeds: [] };
test('extracts GIF attachments without flattening animation', () => {
  const file = { id: 'attachment', url: 'https://cdn.discordapp.com/attachments/1/2/animated.gif', name: 'animated.gif', contentType: 'image/gif', size: 10 };
  expect(extractDiscordMedia({ ...base, attachments: new Map([[file.id, file]]) })).toEqual([{ url: file.url, name: file.name, contentType: file.contentType, size: 10, sourceId: 'message:attachment' }]);
});
test('never forwards spoilered attachments or unfurls of spoilered links', () => {
  const file = (name: string) => ({ id: name, url: `https://cdn.discordapp.com/attachments/1/2/${name}`, name, contentType: 'image/png', size: 10 });
  const attachments = new Map([['a', file('SPOILER_secret.png')], ['b', file('public.png')]]);
  expect(extractDiscordMedia({ ...base, attachments }).map(media => media.name)).toEqual(['public.png']);
  const embeds = [makeEmbed({ type: EmbedType.GIFV, video: { url: 'https://media.tenor.com/idAAAAC/cat.mp4' } })];
  expect(extractDiscordMedia({ ...base, embeds, content: '||https://tenor.com/view/cat||' })).toEqual([]);
  expect(extractDiscordMedia({ ...base, embeds, content: 'https://tenor.com/view/cat' })).toHaveLength(1);
  expect(extractDiscordMedia({ ...base, embeds, content: 'a || b' })).toHaveLength(1);
});
test('GIF picker unfurls arrive later, use actual animated media and deduplicate repeated updates', () => {
  const catalog = new MediaCatalog(randomBytes(32), 1024);
  expect(extractDiscordMedia(base)).toEqual([]);
  const url = 'https://media.tenor.com/abcAAAAC/cat.mp4';
  const updated = { ...base, embeds: [makeEmbed({ type: EmbedType.GIFV, video: { url }, thumbnail: { url: 'https://example.com/cat.jpg', proxy_url: 'https://images-ext-1.discordapp.net/external/token/cat.jpg' } })] };
  const media = extractDiscordMedia(updated)[0]!;
  expect(media).toMatchObject({ url, name: 'animation.mp4', contentType: 'video/mp4', loop: true });
  expect(catalog.add('channel', 'Discord', media)?.kind).toBe('video');
  expect(catalog.add('channel', 'Discord', extractDiscordMedia(updated)[0]!)).toBeUndefined();
});
test('Klipy GIF picker unfurls are kept as looping video', () => {
  const url = 'https://static1.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/La0HaAzw.mp4';
  const media = extractDiscordMedia({ ...base, embeds: [makeEmbed({ type: EmbedType.GIFV, video: { url } })] });
  expect(media).toEqual([{ url, name: 'animation.mp4', contentType: 'video/mp4', size: 0, sourceId: 'message:embed:0', loop: true }]);
  expect(new MediaCatalog(randomBytes(32), 1024).add('channel', 'Discord', media[0]!)?.kind).toBe('video');
});
test('accepts Discord external image proxies but never forwards external HTML or YouTube players', () => {
  const media = extractDiscordMedia({ ...base, embeds: [
    makeEmbed({ type: EmbedType.Image, image: { url: 'https://example.com/test.gif', proxy_url: 'https://images-ext-2.discordapp.net/external/token/test.gif' } }),
    makeEmbed({ type: EmbedType.GIFV, video: { url: 'https://tenor.com/view/cat-123' } }),
    makeEmbed({ type: EmbedType.Video, video: { url: 'https://youtube.com/watch?v=test' } }),
    makeEmbed({ image: { url: 'https://127.0.0.1/private.png' } }),
  ] });
  expect(media).toHaveLength(1);
  expect(media[0]?.url).toContain('images-ext-2.discordapp.net');
});
test('uses an animated GIF thumbnail only when no video is provided, never a static poster', () => {
  expect(extractDiscordMedia({ ...base, embeds: [
    makeEmbed({ type: EmbedType.GIFV, thumbnail: { url: 'https://media.tenor.com/id/animation.gif' } }),
    makeEmbed({ type: EmbedType.GIFV, thumbnail: { url: 'https://example.com/poster.jpg', proxy_url: 'https://images-ext-1.discordapp.net/external/id/poster.jpg' } }),
  ] })).toEqual([expect.objectContaining({ name: 'animation.gif', url: 'https://media.tenor.com/id/animation.gif' })]);
});
test('real discord.js Embed objects expose their type in data, not on the instance', () => {
  const embed = makeEmbed({ type: EmbedType.GIFV, video: { url: 'https://media.tenor.com/id/cat.mp4' } });
  expect('type' in embed).toBe(false);
  expect(embed.data.type).toBe('gifv');
  expect(extractDiscordMedia({ ...base, embeds: [embed] })).toEqual([expect.objectContaining({ contentType: 'video/mp4', loop: true })]);
});
test('a direct image or GIF link may be stored in thumbnail, not image', () => {
  const url = 'https://images-ext-1.discordapp.net/external/token/linked.gif';
  const embed = makeEmbed({ type: EmbedType.Image, thumbnail: { url: 'https://example.com/linked.gif', proxy_url: url } });
  expect(extractDiscordMedia({ ...base, embeds: [embed] })).toEqual([expect.objectContaining({ url, name: 'animation.gif' })]);
});
test('recognizes an extensionless GIF video even though the video getter returns a new object each time', () => {
  const url = 'https://images-ext-1.discordapp.net/external/token/animation';
  const embed = makeEmbed({ type: EmbedType.GIFV, video: { url } });
  expect(embed.video).not.toBe(embed.video);
  expect(extractDiscordMedia({ ...base, embeds: [embed] })).toEqual([expect.objectContaining({ url, contentType: 'video/mp4', loop: true })]);
});
