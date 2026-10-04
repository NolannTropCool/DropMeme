import { readConfig } from './config.js';
import { createApplication } from './app.js';
import { DiscordBot } from './discord.js';

try {
  const config = readConfig(process.env);
  const bot = new DiscordBot(config);
  const { app, ...application } = await createApplication(config, bot);
  app.addHook('onClose', async () => bot.stop());
  const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await bot.start({ app, ...application });
    await app.listen({ host: config.host, port: config.port });
  } catch (error) { await app.close(); throw error; }
} catch (error) {
  // Discord's token must never appear in an exception dump.
  console.error(error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{50,}/g, '[redacted]') : 'Démarrage impossible');
  process.exitCode = 1;
}
