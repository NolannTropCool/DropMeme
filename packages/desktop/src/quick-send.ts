import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { QuickSendRequest } from '@dropmeme/shared';
import type { QuickSendResult, QuickSendState } from './quick-send-host.js';
import './quick-send.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const query = $<HTMLInputElement>('query');
let state: QuickSendState = { online: false };
let pending: string | undefined;
let error = '';

function render(): void {
  query.disabled = !state.online; query.readOnly = !!pending;
  query.placeholder = state.online ? 'Un message pour tout le salon…' : '';
  $('quick-status').textContent = pending ? 'Envoi…'
    : state.online ? `Salon #${state.channelName ?? ''}`
    : state.channelName ? `Reconnexion au salon #${state.channelName}… L’envoi sera possible dès le retour de la connexion.`
    : 'DropMeme n’est connecté à aucun salon. Ouvrez l’application pour vous abonner.';
  $('quick-error').textContent = error;
  if (state.online) query.focus();
}
const hide = () => { void getCurrentWindow().hide(); };

/** Every send goes through the main window, which alone holds the token. GIF, file and favorite results call this too. */
function request(body: Omit<QuickSendRequest, 'id'>): void {
  if (pending || !state.online) return;
  pending = crypto.randomUUID(); error = ''; render();
  void invoke('quick_send', { request: { ...body, id: pending } }).catch(() => { pending = undefined; error = 'DropMeme ne répond pas.'; render(); });
}

$<HTMLFormElement>('quick-form').onsubmit = event => {
  event.preventDefault();
  const text = query.value.trim();
  if (text) request({ kind: 'text', text });
};
window.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });

if (isTauri()) {
  const target = { target: 'quick-send' };
  await listen<QuickSendState>('quick-send-state', event => { state = event.payload; render(); }, target);
  await listen<QuickSendState>('quick-send-open', event => { state = event.payload; error = ''; render(); query.select(); }, target);
  await listen<QuickSendResult>('quick-send-result', event => {
    if (event.payload.id !== pending) return;
    pending = undefined;
    if (event.payload.ok) { query.value = ''; hide(); } else error = event.payload.error;
    render();
  }, target);
}
render();
