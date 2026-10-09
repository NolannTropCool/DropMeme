import { deviceLinkRequestSchema, deviceLinkResponseSchema } from '@dropmeme/shared';
import { readToken, type Preferences } from './preferences.js';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Linking proves ownership with a private, single-use Discord command code. */
export class DiscordIdentity {
  private available = false;
  private busy = false;
  private relinking = false;

  constructor(private readonly preferences: () => Preferences, private readonly save: () => Promise<void>) {
    element<HTMLFormElement>('discord-link-form').onsubmit = event => { event.preventDefault(); void this.link(); };
    element('discord-relink').onclick = () => { this.relinking = true; this.render(); element('discord-link-code').focus(); };
  }

  setOnline(online: boolean, version = ''): void {
    const [major = 0, minor = 0] = version.split('.').map(Number);
    this.available = online && (major > 0 || minor >= 3);
    this.render();
  }

  render(): void {
    const { subscription, settings } = this.preferences();
    const id = subscription?.discordUserId;
    // Devices linked before names were stored only know the account ID.
    element('discord-identity-status').textContent = id ? subscription?.discordUserName ?? `ID ${id}` : 'Aucun compte lié';
    element('discord-identity-hint').textContent = !id ? '' : settings.acceptDirect
      ? 'Les médias qui vous mentionnent sur Discord arrivent sur cet appareil.'
      : 'Activez « Accepter les envois directs » dans Envois pour recevoir les médias qui vous mentionnent.';
    element('discord-link-form').hidden = !!id && !this.relinking;
    element('discord-relink').hidden = !id || this.relinking;
    element<HTMLButtonElement>('discord-link-button').disabled = !this.available || this.busy;
    element<HTMLInputElement>('discord-link-code').disabled = !this.available || this.busy;
    element('discord-link-hint').textContent = this.available
      ? 'Dans ce salon Discord, utilisez /dropmeme avec votre compte, puis collez le code privé ici. Ne partagez pas ce code. Activez les envois directs pour recevoir les médias qui vous mentionnent.'
      : 'La liaison par mention nécessite une connexion à un serveur DropMeme 0.3 ou plus récent.';
  }

  private async link(): Promise<void> {
    if (!this.available || this.busy) return;
    const input = element<HTMLInputElement>('discord-link-code');
    const status = element('discord-link-status');
    const body = { code: input.value.trim().toUpperCase() };
    if (!deviceLinkRequestSchema.safeParse(body).success) { status.textContent = 'Saisissez le code complet XXXXXXXX-XXXXXXXX.'; return; }
    const { server, subscription } = this.preferences();
    this.busy = true; this.render(); status.textContent = 'Liaison…';
    try {
      const token = await readToken();
      if (!token || !subscription) throw new Error('Abonnement introuvable.');
      const response = await fetch(`${server}/v2/device/link`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) throw new Error(response.status === 401 ? 'Code invalide, expiré, déjà utilisé ou créé dans un autre salon.' : 'Liaison refusée par le serveur.');
      const result = deviceLinkResponseSchema.parse(await response.json());
      if (this.preferences().server !== server || this.preferences().subscription?.deviceId !== subscription.deviceId) throw new Error('L’abonnement a changé. Relancez la liaison.');
      const current = this.preferences().subscription!;
      current.discordUserId = result.discordUserId; current.discordUserName = result.discordUserName;
      await this.save(); input.value = ''; this.relinking = false; status.textContent = 'Compte lié.';
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'Liaison impossible.'; }
    finally { this.busy = false; this.render(); }
  }
}
