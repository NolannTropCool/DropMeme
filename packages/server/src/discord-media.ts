import type { Embed } from 'discord.js';
import { isDiscordMediaUrl, type IncomingMedia } from './media.js';

export interface MediaMessage {
  id: string;
  attachments: { values(): IterableIterator<{ id: string; url: string; name: string; contentType: string | null; size: number }> };
  embeds: readonly Pick<Embed, 'data' | 'image' | 'video' | 'thumbnail'>[];
}

/** Discord unfurls GIF picker links asynchronously. Accept files, never execute external players. */
export function extractDiscordMedia(message: MediaMessage): IncomingMedia[] {
  const result: IncomingMedia[] = [];
  for (const attachment of message.attachments.values()) {
    if (result.length >= 10) break;
    result.push({ url: attachment.url, name: attachment.name, contentType: attachment.contentType, size: attachment.size, sourceId: `${message.id}:${attachment.id}` });
  }
  for (const [index, embed] of message.embeds.entries()) {
    if (result.length >= 10) break;
    // Embed has no `type` getter. Read the raw API data, and capture asset getters once:
    // each getter returns a fresh object, so comparing against a second embed.video read fails.
    const { data, image, video, thumbnail } = embed;
    const gif = data.type === 'gifv';
    const animatedThumbnail = [thumbnail?.proxyURL, thumbnail?.url].some(url => {
      if (!url || !isDiscordMediaUrl(url)) return false;
      return new URL(url).pathname.toLowerCase().endsWith('.gif');
    }) ? thumbnail : undefined;
    const asset = gif ? video ?? image ?? animatedThumbnail : image ?? (data.type === 'image' ? thumbnail : undefined);
    const url = [asset?.proxyURL, asset?.url].find(value => value && isDiscordMediaUrl(value));
    if (!url) continue;
    const extension = new URL(url).pathname.split('.').at(-1)?.toLowerCase();
    const isVideo = gif && extension !== 'gif' && (extension === 'mp4' || extension === 'webm' || asset === video);
    result.push({ url, name: isVideo ? `animation.${extension === 'webm' ? 'webm' : 'mp4'}` : gif ? 'animation.gif' : 'image.jpg', contentType: isVideo ? (extension === 'webm' ? 'video/webm' : 'video/mp4') : null, size: 0, sourceId: `${message.id}:embed:${index}`, ...(isVideo ? { loop: true } : {}) });
  }
  return result;
}
