import { Client, Events, GatewayIntentBits, MessageFlags, Options, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, type Message } from 'discord.js';
import type { Config } from './config.js';
import type { Application, DiscordBridge } from './app.js';

export async function registerCommand(config: Config): Promise<void> {
  const command = new SlashCommandBuilder()
    .setName('dropmeme')
    .setDescription('Connecter DropMeme à ce salon (code privé valable 10 minutes)');
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  // POST upserts only this command; never overwrite unrelated bot commands.
  await rest.post(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: command.toJSON() });
}

export class DiscordBot implements DiscordBridge {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    // DropMeme does not need Discord message history or a growing message cache.
    makeCache: Options.cacheWithLimits({ MessageManager: 0, PresenceManager: 0 }),
  });
  private application: Application | undefined;

  constructor(private readonly config: Config) {}
  connected(): boolean { return this.client.isReady(); }

  async channelName(id: string): Promise<string | undefined> {
    if (!this.config.allowedChannelIds.has(id)) return undefined;
    const channel = await this.client.channels.fetch(id).catch(() => null);
    if (!channel || !channel.isTextBased() || !('guildId' in channel) || channel.guildId !== this.config.guildId || !('name' in channel)) return undefined;
    const bot = await channel.guild.members.fetchMe();
    if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ViewChannel)) return undefined;
    return channel.name;
  }

  async start(application: Application): Promise<void> {
    this.application = application;
    this.client.on(Events.Error, error => application.app.log.error({ name: error.name }, 'Discord error'));
    this.client.on(Events.ShardDisconnect, () => application.publishStatus());
    this.client.on(Events.ShardResume, () => application.publishStatus());
    this.client.on(Events.ClientReady, () => application.publishStatus());
    this.client.on(Events.MessageCreate, message => this.forward(message));
    this.client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'dropmeme') return;
      try {
        if (interaction.guildId !== this.config.guildId || !this.config.allowedChannelIds.has(interaction.channelId) || !interaction.memberPermissions?.has(PermissionFlagsBits.ViewChannel)) {
          await interaction.reply({ content: 'Ce salon n’est pas autorisé pour DropMeme.', flags: MessageFlags.Ephemeral }); return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = await this.channelName(interaction.channelId);
        if (!name) { await interaction.editReply('Le bot ne peut pas accéder à ce salon.'); return; }
        const code = application.store.createPairing(interaction.channelId, name);
        await interaction.editReply(`Dans DropMeme, utilisez le serveur **${this.config.publicUrl}** et ce code :\n\`${code}\`\nValable 10 minutes, pour un seul appareil. Ne partagez ce code qu’avec une personne autorisée.`);
      } catch { application.app.log.warn('Discord pairing command failed'); }
    });
    await registerCommand(this.config);
    await this.client.login(this.config.discordToken);
    // login() resolves before ClientReady on some gateway flows.
    if (!this.client.isReady()) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Discord startup timeout')), 30_000);
      this.client.once(Events.ClientReady, () => { clearTimeout(timer); resolve(); });
    });
    for (const id of this.config.allowedChannelIds) {
      if (!await this.channelName(id)) throw new Error(`Salon Discord inaccessible : ${id}`);
    }
  }

  private forward(message: Message): void {
    if (!this.application || message.guildId !== this.config.guildId || !this.config.allowedChannelIds.has(message.channelId)) return;
    // The sender's text is never sent to clients, only the media and display name.
    const author = message.member?.displayName ?? message.author.displayName;
    let count = 0;
    for (const attachment of message.attachments.values()) {
      if (count >= 10) break;
      if (this.application.publish(message.channelId, author, {
        url: attachment.url, name: attachment.name, contentType: attachment.contentType, size: attachment.size,
        sourceId: `${message.id}:${attachment.id}`,
      })) count++;
    }
    for (const [index, embed] of message.embeds.entries()) {
      if (count >= 10) break;
      // Discord-hosted image proxies cover image links. YouTube/Tenor players are not executed.
      const image = embed.image;
      if (image?.proxyURL && this.application.publish(message.channelId, author, {
        url: image.proxyURL, name: 'image.jpg', contentType: null, size: 0, sourceId: `${message.id}:embed:${index}`,
      })) count++;
    }
  }

  async stop(): Promise<void> { await this.client.destroy(); }
}
