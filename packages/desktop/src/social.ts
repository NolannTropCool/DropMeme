import type { Peer } from '@dropmeme/shared';
import { readToken, type Preferences } from './preferences.js';
import { toast } from './toast.js';
import { sendFile, sendText } from './send.js';

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
      const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.ariaHidden = 'true';
      avatar.textContent = [...peer.name.trim()][0]?.toUpperCase() ?? '?';
      const name = document.createElement('strong'); name.textContent = peer.name;
      if (peer.id === this.preferences().subscription?.deviceId) name.append(' ', Object.assign(document.createElement('small'), { textContent: 'vous' }));
      const direct = document.createElement('span'); direct.className = peer.acceptDirect ? 'direct on' : 'direct';
      direct.textContent = peer.acceptDirect ? 'Envois directs acceptés' : 'Envois directs désactivés';
      row.append(avatar, name, direct); element('peers-list').append(row);
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
    if (!text && !file) { toast('Saisissez un texte ou choisissez un fichier.', 'error'); return; }
    this.busy = true; this.render(); this.button.textContent = 'Envoi…';
    let sent = 0;
    try {
      const token = await readToken();
      if (!token) throw new Error('Abonnement introuvable.');
      const unchanged = () => {
        if (!this.online || this.preferences().server !== server || this.preferences().subscription?.deviceId !== subscription?.deviceId) throw new Error('L’abonnement a changé. Relancez l’envoi.');
      };
      if (text) { unchanged(); await sendText(server, token, text, recipientId); sent++; textInput.value = ''; }
      if (file) { unchanged(); await sendFile(server, token, file, recipientId); sent++; fileInput.value = ''; }
      toast(`${sent} envoi(s) transmis${recipientId ? ' au destinataire' : ' au salon'}.`);
    } catch (error) {
      toast(`${sent ? `${sent} envoi transmis. ` : ''}${error instanceof Error ? error.message : 'Envoi impossible.'}`, 'error');
    } finally { this.busy = false; this.button.textContent = 'Envoyer'; this.render(); }
  }
}
