import { MessageMentions, type Embed } from 'discord.js';
import type { IncomingMedia } from './media.js';

/** Use Discord's user-mention syntax directly; SDK caches and reply pings cannot define routing. */
export function mentionedUsers(content: string): string[] {
  const pattern = new RegExp(MessageMentions.UsersPattern.source, 'g');
  return [...new Set([...content.matchAll(pattern)].map(match => match.groups!.id!))];
}

/** Routing mentions never become visible text. Preserve paragraph breaks in captions. */
export function displayText(content: string): string {
  return content.replace(/<@!?\d{17,20}>/g, '').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim().slice(0, 2000);
}

/** Hide the links that produced media, while keeping unrelated links in the sender's text. */
export function mediaCaption(content: string, media: readonly IncomingMedia[], embeds: readonly Pick<Embed, 'data'>[]): string {
  const sources = new Set(media.map(item => item.url));
  for (const item of media) {
    const index = /:embed:(\d+)$/.exec(item.sourceId ?? '')?.[1];
    const url = index !== undefined ? embeds[Number(index)]?.data.url : undefined;
    if (url) sources.add(url);
  }
  const caption = content.replace(/<?https?:\/\/[^\s<>]+>?/gi, value => {
    const url = value.replace(/^<|>$/g, '');
    try {
      // GIF picker pages can precede the embed, and their URL is not always included in it.
      const host = new URL(url).hostname;
      return sources.has(url) || host === 'tenor.com' || host === 'www.tenor.com' ? '' : value;
    } catch { return value; }
  });
  return displayText(caption);
}
