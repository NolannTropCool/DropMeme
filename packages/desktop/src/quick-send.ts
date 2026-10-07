import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { GifResult, QuickSendRequest } from '@dropmeme/shared';
import type { QuickSendResult, QuickSendState } from './quick-send-host.js';
import { accepted, defaultMaxMediaBytes, fileError, formatSize, gridMove, renderGrid } from './picker.js';
import { toast } from './toast.js';
import './quick-send.css';

type Body<R = QuickSendRequest> = R extends unknown ? Omit<R, 'id'> : never;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const query = $<HTMLInputElement>('query');
const results = $('results');
const browse = $<HTMLInputElement>('browse');
let state: QuickSendState = { online: false, gifSearch: false, maxMediaBytes: defaultMaxMediaBytes };
let pending: { id: string; kind: Body['kind']; keepOpen: boolean } | undefined;
let search: { id: string; page: number } | undefined;
let gifs: GifResult[] = [];
let page = 1;
let hasNext = false;
let selected = -1;
let file: File | undefined;
let thumb: string | undefined;
let browsing = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
let blur: ReturnType<typeof setTimeout> | undefined;

function render(): void {
  query.disabled = !state.online; query.readOnly = !!pending;
  // Klipy attribution: this exact placeholder whenever its search is offered.
  query.placeholder = !state.online ? '' : state.gifSearch ? 'Search KLIPY' : 'Écrire un message ou déposer un fichier…';
  $('quick-status').textContent = pending ? 'Envoi…'
    : state.online ? `Salon #${state.channelName ?? ''}${search ? ' · Recherche…' : ''}`
    : state.channelName ? `Reconnexion au salon #${state.channelName}… L’envoi sera possible dès le retour de la connexion.`
    : 'DropMeme n’est connecté à aucun salon. Ouvrez l’application pour vous abonner.';
  $('file-preview').hidden = !file;
  results.hidden = !!file || !state.gifSearch || !gifs.length; query.ariaExpanded = String(!results.hidden);
  $('more').hidden = results.hidden || !hasNext || page >= 20;
  $<HTMLButtonElement>('browse-button').disabled = !state.online || !!pending;
  $('hint').textContent = file ? 'Entrée : envoyer le fichier · Ctrl+Entrée : sans fermer · Échap : retirer le fichier'
    : `Entrée : envoyer au salon · Ctrl+Entrée : sans fermer · ${state.gifSearch ? 'Flèches : choisir un GIF · ' : ''}Ctrl+V : coller une image · Échap : fermer`;
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

/** Invalid files are refused at once, with the server's rules; the attached one stays. */
function attach(next: File | undefined): void {
  const invalid = next && fileError(next, state.maxMediaBytes);
  if (invalid) { toast(invalid, 'error'); return; }
  if (thumb) URL.revokeObjectURL(thumb);
  file = next; thumb = next && URL.createObjectURL(next);
  const media = file?.type.startsWith('video/') ? Object.assign(document.createElement('video'), { muted: true, loop: true, autoplay: true }) : document.createElement('img');
  if (thumb) media.src = thumb;
  $('file-thumb').replaceChildren(...thumb ? [media] : []);
  $('file-name').textContent = file?.name ?? ''; $('file-size').textContent = file ? formatSize(file.size) : '';
  render();
}

/** Every request goes through Rust to the main window, which alone holds the token. */
function relay(body: Body, blob?: Blob): string {
  const id = crypto.randomUUID();
  // File bytes are staged in Rust as a raw IPC body under the request id, never serialized into the request.
  const staged = blob ? blob.arrayBuffer().then(bytes => invoke('stage_file', bytes, { headers: { 'x-request-id': id } })) : Promise.resolve();
  void staged.then(() => invoke('quick_send', { request: { ...body, id } }))
    .catch((error: unknown) => answer({ id, ok: false, error: typeof error === 'string' ? error : 'DropMeme ne répond pas.' }));
  return id;
}
function send(body: Body, keepOpen: boolean, blob?: Blob): void {
  if (pending || !state.online) return;
  pending = { id: relay(body, blob), kind: body.kind, keepOpen }; render();
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
      if (kind === 'file') attach(undefined);
      if (keepOpen) toast(`${kind === 'gif' ? 'GIF envoyé' : kind === 'file' ? 'Fichier envoyé' : 'Message envoyé'} au salon.`); else hide();
    }
  } else return;
  render();
}

function submit(keepOpen: boolean): void {
  if (file) return send({ kind: 'file', name: file.name, type: file.type }, keepOpen, file);
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
browse.accept = Object.keys(accepted).map(extension => `.${extension}`).join(',');
// The file dialog takes the focus: do not hide behind it.
$('browse-button').onclick = () => { browsing = true; browse.click(); };
browse.onchange = () => { browsing = false; attach(browse.files?.[0]); browse.value = ''; };
browse.oncancel = () => { browsing = false; };
window.addEventListener('paste', event => {
  const pasted = event.clipboardData?.files[0];
  if (!pasted) return;
  event.preventDefault();
  // Screenshots and copied images arrive as a bare "image.png".
  attach(pasted.type === 'image/png' ? new File([pasted], `capture-${new Date().toLocaleString('sv-SE').replace(/\D/g, '-')}.png`, { type: 'image/png' }) : pasted);
});
// dragDropEnabled is off for this window (tauri.conf.json), so dropped files reach the page as HTML drops.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('dragenter', () => clearTimeout(blur));
window.addEventListener('dragleave', event => { if (!event.relatedTarget && !document.hasFocus()) blur = setTimeout(hide, 1500); });
window.addEventListener('drop', event => {
  // Also stops a dropped link from navigating the launcher away.
  event.preventDefault();
  const dropped = event.dataTransfer?.files[0];
  if (dropped) { attach(dropped); if (isTauri()) void getCurrentWindow().setFocus(); }
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') { if (file) attach(undefined); else hide(); } });

if (isTauri()) {
  const target = { target: 'quick-send' };
  await listen<QuickSendState>('quick-send-state', event => { state = event.payload; render(); }, target);
  await listen<QuickSendState>('quick-send-open', event => { state = event.payload; $('toasts').replaceChildren(); select(-1); render(); query.select(); }, target);
  await listen<QuickSendResult>('quick-send-result', event => answer(event.payload), target);
  // Hide on focus loss like a launcher, but leave time to start dragging a file from another window.
  // ponytail: fixed 1.5 s grace; track the drag source if it proves too short or too long.
  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    clearTimeout(blur);
    if (focused) browsing = false;
    else if (!browsing) blur = setTimeout(hide, 1500);
  });
}
render();
