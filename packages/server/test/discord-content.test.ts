import { expect, test } from 'vitest';
import { EmbedType } from 'discord.js';
import { displayText, mediaCaption, mentionedUsers } from '../src/discord-content.js';
import { makeEmbed } from './discord-fixtures.js';

test('explicit user mentions route without resolving cached users; roles and reply pings are not targets', () => {
  expect(mentionedUsers('Salut <@123456789012345678> <@!223456789012345678> <@123456789012345678> <@&323456789012345678> @everyone')).toEqual(['123456789012345678', '223456789012345678']);
  expect(mentionedUsers('Un message sans mention explicite')).toEqual([]);
  expect(displayText(' <@123456789012345678> Bonjour <@!223456789012345678> !\n\n À demain ')).toBe('Bonjour !\n\nÀ demain');
});

test('a caption excludes media links and routing mentions, preserves unrelated URLs and literal text', () => {
  const url = 'https://media.tenor.com/animation/cat.mp4';
  const page = 'https://tenor.com/view/cat-123';
  expect(mediaCaption(`Bravo <@123456789012345678> !\n${page}\nhttps://example.com <script>`, [{ url, name: 'cat.mp4', contentType: 'video/mp4', sourceId: 'message:embed:0' }], [makeEmbed({ type: EmbedType.GIFV, url: page, video: { url } })])).toBe('Bravo !\n\nhttps://example.com <script>');
  expect(mediaCaption(`<@123456789012345678> ${url}`, [{ url, name: 'cat.mp4', contentType: 'video/mp4' }], [])).toBe('');
  expect(mediaCaption('Mon fichier et son texte', [], [])).toBe('Mon fichier et son texte');
});
