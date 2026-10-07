import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { GifResult, QuickSendRequest } from '@dropmeme/shared';
import type { QuickSendResult, QuickSendState } from './quick-send-host.js';
import { gridMove, renderGrid } from './picker.js';
import { toast } from './toast.js';
import './quick-send.css';

type Body<R = QuickSendRequest> = R extends unknown ? Omit<R, 'id'> : never;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const query = $<HTMLInputElement>('query');
const results = $('results');
let state: QuickSendState = { online: false, gifSearch: false };
let pending: { id: string; kind: Body['kind']; keepOpen: boolean } | undefined;
let search: { id: string; page: number } | undefined;
let gifs: GifResult[] = [];
let page = 1;
let hasNext = false;
let selected = -1;
let debounce: ReturnType<typeof setTimeout> | undefined;

function render(): void {
  query.disabled = !state.online; query.readOnly = !!pending;
  // Klipy attribution: this exact placeholder whenever its search is offered.
  query.placeholder = !state.online ? '' : state.gifSearch ? 'Search KLIPY' : 'Un message pour tout le salon…';
  $('quick-status').textContent = pending ? 'Envoi…'
    : state.online ? `Salon #${state.channelName ?? ''}${search ? ' · Recherche…' : ''}`
    : state.channelName ? `Reconnexion au salon #${state.channelName}… L’envoi sera possible dès le retour de la connexion.`
    : 'DropMeme n’est connecté à aucun salon. Ouvrez l’application pour vous abonner.';
  results.hidden = !state.gifSearch || !gifs.length; query.ariaExpanded = String(!results.hidden);
  $('more').hidden = results.hidden || !hasNext || page >= 20;
  if (state.online) query.focus();
}
const hide = () => { void getCurrentWindow().hide(); };

function select(index: number): void {
  selected = index;
  for (const tile of results.children) tile.ariaSelected = String(tile.id === `tile-${index}`);
  const tile = document.getElementById(`tile-${index}`);
  if (tile) { query.setAttribute('aria-activedescendant', tile.id); tile.scrollIntoView({ block: 'nearest' }); }
  else query.removeAttribute('aria-activedescendant');
}

/** Every request goes through Rust to the main window, which alone holds the token. */
function relay(body: Body): string {
  const id = crypto.randomUUID();
  void invoke('quick_send', { request: { ...body, id } }).catch(() => answer({ id, ok: false, error: 'DropMeme ne répond pas.' }));
  return id;
}
function send(body: Body, keepOpen: boolean): void {
  if (pending || !state.online) return;
  pending = { id: relay(body), kind: body.kind, keepOpen }; render();
}

function find(next = 1): void {
  const q = query.value.trim();
  if (!state.gifSearch || q.length < 2 || q.length > 100) { search = undefined; gifs = []; hasNext = false; select(-1); }
  else search = { id: relay({ kind: 'search', q, page: next }), page: next };
  render();
}

function answer(result: QuickSendResult): void {
  // Only the latest search counts: an older answer would replace fresher results.
  if (result.id === search?.id) {
    const loaded = search.page; search = undefined;
    if (!result.ok) toast(result.error, 'error');
    else {
      gifs = loaded === 1 ? result.gifs!.results : [...gifs, ...result.gifs!.results]; page = loaded; hasNext = result.gifs!.hasNext;
      renderGrid(results, gifs, (i, keepOpen) => send({ kind: 'gif', gif: gifs[i]!.id }, keepOpen));
      select(loaded === 1 ? -1 : selected);
    }
  } else if (result.id === pending?.id) {
    const { kind, keepOpen } = pending; pending = undefined;
    if (!result.ok) toast(result.error, 'error');
    else {
      if (kind === 'text') { query.value = ''; find(); }
      if (keepOpen) toast(kind === 'gif' ? 'GIF envoyé au salon.' : 'Message envoyé au salon.'); else hide();
    }
  } else return;
  render();
}

function submit(keepOpen: boolean): void {
  const gif = gifs[selected];
  if (gif) return send({ kind: 'gif', gif: gif.id }, keepOpen);
  const text = query.value.trim();
  if (text) send({ kind: 'text', text }, keepOpen);
}

$<HTMLFormElement>('quick-form').onsubmit = event => event.preventDefault();
query.oninput = () => { select(-1); clearTimeout(debounce); debounce = setTimeout(() => find(), 300); };
query.onkeydown = event => {
  if (event.isComposing) return;
  if (event.key === 'Enter') { event.preventDefault(); submit(event.ctrlKey); return; }
  const next = gridMove(selected, event, results.hidden ? 0 : gifs.length, getComputedStyle(results).gridTemplateColumns.split(' ').length);
  if (next === undefined) return;
  event.preventDefault(); select(next);
};
$('more').onclick = () => find(page + 1);
window.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });

if (isTauri()) {
  const target = { target: 'quick-send' };
  await listen<QuickSendState>('quick-send-state', event => { state = event.payload; render(); }, target);
  await listen<QuickSendState>('quick-send-open', event => { state = event.payload; $('toasts').replaceChildren(); select(-1); render(); query.select(); }, target);
  await listen<QuickSendResult>('quick-send-result', event => answer(event.payload), target);
}
render();
