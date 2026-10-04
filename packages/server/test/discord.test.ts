import { describe, expect, test, vi } from 'vitest';
import { Routes, type REST } from 'discord.js';
import { registerCommand } from '../src/discord.js';
import type { Config } from '../src/config.js';

const appId = '123456789012345678';
const guildId = '223456789012345678';
const config: Config = {
  discordToken: 'fixture-secret-do-not-log', applicationId: appId, guildId,
  allowedChannelIds: new Set(['323456789012345678']), publicUrl: 'https://example.com',
  joinKey: undefined, port: 3000, host: '0.0.0.0', databasePath: ':memory:', maxMediaBytes: 1024, maxClients: 10,
};

function api() {
  return {
    get: vi.fn<REST['get']>().mockResolvedValueOnce({ id: appId }).mockResolvedValueOnce({ id: guildId }),
    post: vi.fn<REST['post']>().mockResolvedValue({}),
  };
}

describe('Discord registration diagnostics', () => {
  test('verifies token identity and guild access before upserting only /dropmeme', async () => {
    const rest = api();
    await registerCommand(config, rest);
    expect(rest.get.mock.calls.map(call => call[0])).toEqual([Routes.oauth2CurrentApplication(), Routes.guild(guildId)]);
    expect(rest.post).toHaveBeenCalledOnce();
    expect(rest.post).toHaveBeenCalledWith(Routes.applicationGuildCommands(appId, guildId), expect.objectContaining({ body: expect.objectContaining({ name: 'dropmeme' }) }));
  });

  test('wrong application ID is reported without attempting to register commands', async () => {
    const rest = api();
    await expect(registerCommand({ ...config, applicationId: guildId }, rest)).rejects.toThrow(`DISCORD_APPLICATION_ID ne correspond pas au bot du DISCORD_TOKEN. Utilisez l’ID d’application ${appId}.`);
    expect(rest.get).toHaveBeenCalledOnce();
    expect(rest.post).not.toHaveBeenCalled();
  });

  test('guild denial points to server membership and the guild ID', async () => {
    const rest = api();
    rest.get.mockReset().mockResolvedValueOnce({ id: appId }).mockRejectedValueOnce({ code: 50001, status: 403 });
    await expect(registerCommand(config, rest)).rejects.toThrow(/accès au serveur Discord \(50001 Missing Access\).*DISCORD_GUILD_ID/);
    expect(rest.post).not.toHaveBeenCalled();
  });

  test('command denial points to installation scopes without leaking request data', async () => {
    const rest = api();
    rest.post.mockRejectedValue({ code: 50001, status: 403, message: config.discordToken, requestBody: { secret: config.discordToken } });
    const error = await registerCommand(config, rest).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/enregistrement de \/dropmeme \(50001 Missing Access\)/);
    expect(message).toContain('bot et applications.commands');
    expect(message).not.toContain(config.discordToken);
  });

  test('invalid token reports credential configuration, not channel permissions', async () => {
    const rest = api();
    rest.get.mockReset().mockRejectedValueOnce({ status: 401 });
    await expect(registerCommand(config, rest)).rejects.toThrow(/token du bot invalide/);
    expect(rest.post).not.toHaveBeenCalled();
  });
});
