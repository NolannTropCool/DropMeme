import { Client, Events, GatewayIntentBits, MessageFlags, Options, Partials, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, type Message, type PartialMessage } from 'discord.js';
import { extractDiscordMedia } from './discord-media.js';
import { displayText, mediaCaption, mentionedUsers } from './discord-content.js';
import type { Config } from './config.js';
import type { Application, DiscordBridge } from './app.js';

function registrationError(stage: 'identity' | 'guild' | 'command', error: unknown): Error {
  const failure = typeof error === 'object' && error !== null ? error as { code?: unknown; status?: unknown } : {};
  const code = typeof failure.code === 'number' ? failure.code : undefined;
  const status = typeof failure.status === 'number' ? failure.status : undefined;
  const operation = { identity: 'identification du bot', guild: 'accès au serveur Discord', command: 'enregistrement de /dropmeme' }[stage];
  if (status === 401 || code === 50014) return new Error(`Discord — ${operation} : token du bot invalide. Vérifiez DISCORD_TOKEN dans les variables du service server.`);
  const details = code === 50001 ? '50001 Missing Access' : code === 50013 ? '50013 Missing Permissions' : code === 10004 ? '10004 Unknown Guild' : status ? `HTTP ${status}` : 'requête échouée';
  const help = stage === 'guild'
    ? 'Vérifiez DISCORD_GUILD_ID (ID du serveur, pas du salon) et que le bot est membre de ce serveur.'
    : stage === 'command'
      ? 'Vérifiez l’installation de cette application dans le serveur avec les scopes bot et applications.commands. Réinvitez le bot si nécessaire.'
      : 'Vérifiez le token du bot et l’accès réseau à Discord.';
  // Never serialize DiscordAPIError: its request data can contain credentials.
  return new Error(`Discord — ${operation} (${details}). ${help}`);
}

export async function registerCommand(config: Config, api?: Pick<REST, 'get' | 'post'>): Promise<void> {
  const command = new SlashCommandBuilder()
    .setName('dropmeme')
    .setDescription('Connecter DropMeme à ce salon (code privé valable 10 minutes)');
  const rest = api ?? new REST({ version: '10' }).setToken(config.discordToken);
  let identity: { id?: string };
  try { identity = await rest.get(Routes.oauth2CurrentApplication()) as { id?: string }; }
  catch (error) { throw registrationError('identity', error); }
  if (!identity.id) throw new Error('Discord : impossible de vérifier l’identifiant de l’application du bot.');
  if (identity.id !== config.applicationId) {
    throw new Error(`DISCORD_APPLICATION_ID ne correspond pas au bot du DISCORD_TOKEN. Utilisez l’ID d’application ${identity.id}.`);
  }
  try { await rest.get(Routes.guild(config.guildId)); }
  catch (error) { throw registrationError('guild', error); }
  // POST upserts only this command; never overwrite unrelated bot commands.
  try { await rest.post(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: command.toJSON() }); }
  catch (error) { throw registrationError('command', error); }
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    // DropMeme does not need Discord message history or a growing message cache.
    makeCache: Options.cacheWithLimits({ MessageManager: 0, PresenceManager: 0 }),
    partials: [Partials.Message],
  });
}

export class DiscordBot implements DiscordBridge {
  private application: Application | undefined;
  private readonly messages = new Map<string, { name: string; content: string; recipientIds?: string[]; time: number }>();

  constructor(private readonly config: Config, private readonly client: Client = createDiscordClient()) {}
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
    // With no history cache, delayed embeds arrive as PartialMessage objects. Do not fetch history.
    this.client.on(Events.MessageUpdate, (_before, message) => this.forward(message));
    this.client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'dropmeme') return;
      try {
        if (interaction.guildId !== this.config.guildId || !this.config.allowedChannelIds.has(interaction.channelId) || !interaction.memberPermissions?.has(PermissionFlagsBits.ViewChannel)) {
          await interaction.reply({ content: 'Ce salon n’est pas autorisé pour DropMeme.', flags: MessageFlags.Ephemeral }); return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = await this.channelName(interaction.channelId);
        if (!name) { await interaction.editReply('Le bot ne peut pas accéder à ce salon.'); return; }
        const code = application.store.createPairing(interaction.channelId, name, Date.now(), interaction.user.id, interaction.user.displayName);
        await interaction.editReply(`Dans DropMeme, utilisez le serveur **${this.config.publicUrl}** et ce code :\n\`${code}\`\nIl permet de vous abonner ou de lier un appareil déjà abonné à votre compte Discord. Valable 10 minutes, pour un seul appareil. Gardez-le privé : les médias qui vous mentionnent seront envoyés à cet appareil s’il accepte les envois directs.`);
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

  private forward(message: Message | PartialMessage): void {
    if (!this.application || message.guildId !== this.config.guildId || !this.config.allowedChannelIds.has(message.channelId)) return;
    // Preserve routing as well as the caption for GIF embeds received after the original message.
    if (Date.now() - message.createdTimestamp > 5 * 60_000) return;
    for (const [id, value] of this.messages) if (Date.now() - value.time > 5 * 60_000) this.messages.delete(id);
    const previous = this.messages.get(message.id);
    // An uncached partial cannot establish whether this was a private mention. Never broadcast it.
    if (message.content === null && !previous) return;
    const author = message.member?.displayName ?? message.author?.displayName ?? previous?.name ?? 'Discord';
    const content = message.content ?? previous!.content;
    const mentioned = message.content !== null ? mentionedUsers(content) : previous?.recipientIds;
    const recipientIds = mentioned?.length ? mentioned : undefined;
    this.messages.set(message.id, { name: author, content: content.slice(0, 2000), ...(recipientIds ? { recipientIds } : {}), time: Date.now() });
    if (this.messages.size > 500) this.messages.delete(this.messages.keys().next().value!);
    const media = extractDiscordMedia(message);
    const caption = mediaCaption(content, media, message.embeds);
    for (const item of media) {
      const input = { ...item, ...(caption ? { caption } : {}) };
      if (recipientIds) this.application.publish(message.channelId, author, input, recipientIds);
      else this.application.publish(message.channelId, author, input);
    }
    if (content.trim() && !message.attachments.size && !message.embeds.length && !/https?:\/\//i.test(content)) {
      const text = displayText(content);
      if (recipientIds) this.application.publishText(message.channelId, author, text, `${message.id}:text`, recipientIds);
      else this.application.publishText(message.channelId, author, text, `${message.id}:text`);
    }
  }

  async stop(): Promise<void> { await this.client.destroy(); }
}
