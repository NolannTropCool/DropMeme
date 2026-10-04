import { isDiscordMediaUrl, type IncomingMedia } from './media.js';

interface EmbedAsset { url?: string | null; proxyURL?: string | null }
export interface MediaMessage {
  id: string;
  attachments: { values(): IterableIterator<{ id: string; url: string; name: string; contentType: string | null; size: number }> };
  embeds: readonly { type?: string | null; image?: EmbedAsset | null; video?: EmbedAsset | null; thumbnail?: EmbedAsset | null }[];
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
    const gif = embed.type === 'gifv';
    const animatedThumbnail = [embed.thumbnail?.proxyURL, embed.thumbnail?.url].some(url => {
      if (!url || !isDiscordMediaUrl(url)) return false;
      return new URL(url).pathname.toLowerCase().endsWith('.gif');
    }) ? embed.thumbnail : undefined;
    const asset = gif ? embed.video ?? embed.image ?? animatedThumbnail : embed.image ?? (embed.type === 'image' ? embed.thumbnail : undefined);
    const url = [asset?.proxyURL, asset?.url].find(value => value && isDiscordMediaUrl(value));
    if (!url) continue;
    const extension = new URL(url).pathname.split('.').at(-1)?.toLowerCase();
    const video = gif && extension !== 'gif' && (extension === 'mp4' || extension === 'webm' || asset === embed.video);
    result.push({ url, name: video ? `animation.${extension === 'webm' ? 'webm' : 'mp4'}` : gif ? 'animation.gif' : 'image.jpg', contentType: video ? (extension === 'webm' ? 'video/webm' : 'video/mp4') : null, size: 0, sourceId: `${message.id}:embed:${index}`, ...(video ? { loop: true } : {}) });
  }
  return result;
}
