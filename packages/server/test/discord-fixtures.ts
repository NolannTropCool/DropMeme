import { Embed, Message, type APIEmbed, type Client } from 'discord.js';

// These constructors are private in the declarations, but public at runtime and used by
// discord.js itself to parse Gateway payloads. Use the real classes, never Embed-shaped mocks.
export function makeEmbed(data: APIEmbed): Embed {
  return Reflect.construct(Embed, [data]) as Embed;
}

export function makeMessage(client: Client, guildId: string, channelId: string, embeds: APIEmbed[] = [], age = 0): Message<true> {
  const id = ((BigInt(Date.now() - age - 1420070400000)) << 22n).toString();
  return Reflect.construct(Message, [client, { id, channel_id: channelId, guild_id: guildId, embeds }]) as Message<true>;
}
