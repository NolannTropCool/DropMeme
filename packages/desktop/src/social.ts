import type { Peer } from '@dropmeme/shared';
import { readToken, type Preferences } from './preferences.js';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Presence belongs to the authenticated channel. Never silently retarget an offline recipient. */
export class Social {
  private peers: Peer[] = [];
  private online = false;
  private busy = false;
  private recipient = element<HTMLSelectElement>('recipient');
  private button = element<HTMLButtonElement>('send');

  constructor(private readonly preferences: () => Preferences) {
    element<HTMLFormElement>('send-form').onsubmit = event => { event.preventDefault(); void this.send(); };
    this.recipient.onchange = () => this.render();
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!online) this.peers = [];
    this.render();
  }
  setPeers(peers: Peer[]): void { this.peers = peers; this.render(); }

  private render(): void {
    const selected = this.recipient.value;
    const peers = this.peers.filter(peer => peer.id !== this.preferences().subscription?.deviceId);
    element('peers-list').replaceChildren();
    for (const peer of this.peers) {
      const row = document.createElement('li');
      row.textContent = `${peer.name}${peer.id === this.preferences().subscription?.deviceId ? ' (vous)' : ''} · ${peer.acceptDirect ? 'Accepte les envois directs' : 'Envois directs désactivés'}`;
      element('peers-list').append(row);
    }
    this.recipient.replaceChildren(new Option('Tout le salon', ''));
    for (const peer of peers.filter(peer => peer.acceptDirect)) this.recipient.add(new Option(peer.name, peer.id));
    if (selected && !peers.some(peer => peer.id === selected && peer.acceptDirect)) {
      const missing = new Option('Destinataire indisponible — choisissez à nouveau', selected);
      missing.disabled = true; this.recipient.add(missing);
    }
    this.recipient.value = selected;
    this.button.disabled = this.busy || !this.online || (!!selected && !peers.some(peer => peer.id === selected && peer.acceptDirect));
    element('presence-status').textContent = this.online ? `${this.peers.length} personne(s) connectée(s) au salon` : 'Connectez-vous à un serveur DropMeme 0.2 pour voir les personnes et envoyer.';
  }

  private async send(): Promise<void> {
    if (this.button.disabled || this.busy) return;
    const textInput = element<HTMLTextAreaElement>('send-text');
    const fileInput = element<HTMLInputElement>('send-file');
    const text = textInput.value.trim(); const file = fileInput.files?.[0];
    const recipientId = this.recipient.value || undefined;
    const { server, subscription } = this.preferences();
    const status = element('send-status');
    if (!text && !file) { status.textContent = 'Saisissez un texte ou choisissez un fichier.'; return; }
    this.busy = true; this.render(); status.textContent = 'Envoi…';
    let sent = 0;
    try {
      const token = await readToken();
      if (!token) throw new Error('Abonnement introuvable.');
      const request = async (path: string, body: BodyInit, json = false) => {
        if (!this.online || this.preferences().server !== server || this.preferences().subscription?.deviceId !== subscription?.deviceId) throw new Error('L’abonnement a changé. Relancez l’envoi.');
        const response = await fetch(`${server}${path}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
          body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(90_000),
        });
        if (!response.ok) {
          const result: unknown = await response.json().catch(() => null);
          throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'Envoi refusé par le serveur.');
        }
        sent++;
      };
      if (file) {
        const body = new FormData(); if (text) body.append('caption', text); body.append('file', file);
        await request(`/v2/send/file${recipientId ? `?recipientId=${encodeURIComponent(recipientId)}` : ''}`, body);
        fileInput.value = ''; textInput.value = '';
      } else if (text) { await request('/v2/send/text', JSON.stringify({ text, recipientId }), true); textInput.value = ''; }
      status.textContent = `${sent} envoi(s) transmis${recipientId ? ' au destinataire' : ' au salon'}.`;
    } catch (error) {
      status.textContent = `${sent ? `${sent} envoi transmis. ` : ''}${error instanceof Error ? error.message : 'Envoi impossible.'}`;
    } finally { this.busy = false; this.render(); }
  }
}
