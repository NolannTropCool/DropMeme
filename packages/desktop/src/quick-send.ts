import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Favorite, GifResult, QuickSendRequest } from '@dropmeme/shared';
import type { QuickSendResult, QuickSendState } from './quick-send-host.js';
import { accepted, defaultMaxMediaBytes, fileError, formatSize, gridMove, mediaElement, renderGrid } from './picker.js';
import { favoriteFile, favoritePreview, filterFavorites, forgetPreview, isVideo } from './favorites.js';
import { toast } from './toast.js';
import './quick-send.css';

type Body<R = QuickSendRequest> = R extends unknown ? Omit<R, 'id'> : never;
type Stage = (id: string) => Promise<unknown>;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const query = $<HTMLInputElement>('query');
const results = $('results');
const favorites = $('favorites');
const browse = $<HTMLInputElement>('browse');
let state: QuickSendState = { online: false, gifSearch: false, maxMediaBytes: defaultMaxMediaBytes, favorites: [], received: [] };
let pending: { id: string; kind: Body['kind']; keepOpen: boolean } | undefined;
let search: { id: string; page: number } | undefined;
let gifs: GifResult[] = [];
/** Favorites matching the field. Selection indices run across them, then across the Klipy grid. */
let shown: Favorite[] = [];
let painting = 0;
let page = 1;
let hasNext = false;
let selected = -1;
let file: File | undefined;
let thumb: string | undefined;
let receivedOpen = false;
let browsing = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
let blur: ReturnType<typeof setTimeout> | undefined;

function render(): void {
  query.disabled = !state.online; query.readOnly = !!pending;
  // Klipy attribution: this exact placeholder whenever its search is offered.
  query.placeholder = !state.online ? '' : state.gifSearch ? 'Search KLIPY' : 'Écrire un message ou déposer un fichier…';
  $('quick-status').textContent = pending ? (pending.kind.startsWith('favorite') ? 'Ajout aux favoris…' : 'Envoi…')
    : state.online ? `Salon #${state.channelName ?? ''}${search ? ' · Recherche…' : ''}`
    : state.channelName ? `Reconnexion au salon #${state.channelName}… L’envoi sera possible dès le retour de la connexion.`
    : 'DropMeme n’est connecté à aucun salon. Ouvrez l’application pour vous abonner.';
  const received = receivedOpen && !file;
  $('file-preview').hidden = !file;
  $('received').hidden = !received; $('received-button').ariaExpanded = String(received);
  $('picks').hidden = !!file || received;
  favorites.hidden = $('favorites-title').hidden = !shown.length;
  results.hidden = !state.gifSearch || !gifs.length; $('results-title').hidden = results.hidden || favorites.hidden; query.ariaExpanded = String(!$('picks').hidden && (!favorites.hidden || !results.hidden));
  $('more').hidden = results.hidden || !hasNext || page >= 20;
  for (const id of ['browse-button', 'received-button']) $<HTMLButtonElement>(id).disabled = !state.online || !!pending;
  $('hint').textContent = file ? 'Entrée : envoyer le fichier · Ctrl+Entrée : sans fermer · Ctrl+D : favori · Échap : retirer le fichier'
    : received ? 'Échap : revenir à la recherche'
    : `Entrée : envoyer au salon · Ctrl+Entrée : sans fermer · ${state.gifSearch ? 'Flèches : choisir · Ctrl+D : GIF en favori · ' : shown.length ? 'Flèches : choisir · ' : ''}Ctrl+V : coller une image · Échap : fermer`;
  if (state.online && !received) query.focus();
}
const hide = () => { void getCurrentWindow().hide(); };

const tileId = (index: number) => index < 0 ? '' : index < shown.length ? `fav-${index}` : `tile-${index - shown.length}`;
function select(index: number): void {
  selected = index;
  const id = tileId(index);
  for (const tile of [...favorites.children, ...results.children]) tile.ariaSelected = String(tile.id === id);
  const tile = id ? document.getElementById(id) : null;
  if (tile) { query.setAttribute('aria-activedescendant', tile.id); tile.scrollIntoView({ block: 'nearest' }); }
  else query.removeAttribute('aria-activedescendant');
}

/** Favorites above the Klipy grid, never mixed into it: its results keep their own grid and order. */
async function renderFavorites(): Promise<void> {
  const next = filterFavorites(state.favorites, query.value);
  // Keep a selected Klipy tile selected when the favorites above it change.
  const keep = selected >= shown.length ? selected - shown.length + next.length : -1;
  shown = next; select(keep);
  const paint = ++painting;
  const items = await Promise.all(next.map(async favorite => favorite.kind === 'gif' ? { previewUrl: favorite.previewUrl, label: favorite.name }
    : { previewUrl: await favoritePreview(favorite).catch(() => ''), video: isVideo(favorite.ext), label: favorite.name }));
  if (paint !== painting) return;
  renderGrid(favorites, items, (i, keepOpen) => sendFavorite(next[i]!, keepOpen), { prefix: 'fav' });
  select(selected); render();
}

/** Filled star on the Klipy tiles already in the favorites. */
function stars(): void {
  const saved = new Set(state.favorites.flatMap(favorite => favorite.kind === 'gif' ? [favorite.gif] : []));
  for (const [i, gif] of gifs.entries()) {
    const star = document.querySelector<HTMLButtonElement>(`#tile-${i} .star`);
    if (star) { star.ariaPressed = String(saved.has(gif.id)); star.textContent = saved.has(gif.id) ? '★' : '☆'; }
  }
}

/** Thumbnails load from main's media tickets, only while the list is open. */
function renderReceived(): void {
  $('received-empty').hidden = state.received.length > 0;
  $('received-list').replaceChildren(...!receivedOpen ? [] : state.received.map(media => {
    const row = document.createElement('li');
    const label = document.createElement('span'); label.textContent = `${media.name} · ${media.author}`;
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'browse', textContent: '☆ Ajouter' });
    add.ariaLabel = `Ajouter ${media.name} aux favoris`;
    add.onclick = () => send({ kind: 'favorite-received', media: media.id }, true);
    row.append(mediaElement(media.url, media.kind === 'video'), label, add);
    return row;
  }));
}
function openReceived(open: boolean): void {
  receivedOpen = open; select(-1); renderReceived(); render();
  if (open) $('received-list').querySelector('button')?.focus();
}

function setState(next: QuickSendState): void {
  const changed = (key: 'favorites' | 'received') => JSON.stringify(state[key]) !== JSON.stringify(next[key]);
  const favoritesChanged = changed('favorites'); const receivedChanged = changed('received');
  for (const favorite of state.favorites) if (!next.favorites.some(item => item.id === favorite.id)) forgetPreview(favorite.id);
  state = next;
  if (favoritesChanged) { void renderFavorites(); stars(); }
  if (receivedChanged) renderReceived();
  render();
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

/** Every request goes through Rust to the main window, which alone holds the token. `stage` places file bytes first. */
function relay(body: Body, stage?: Stage): string {
  const id = crypto.randomUUID();
  void (stage?.(id) ?? Promise.resolve()).then(() => invoke('quick_send', { request: { ...body, id } }))
    .catch((error: unknown) => answer({ id, ok: false, error: typeof error === 'string' ? error : 'DropMeme ne répond pas.' }));
  return id;
}
// File bytes are staged in Rust as a raw IPC body under the request id, never serialized into the request.
const staged = (blob: Blob): Stage => id => blob.arrayBuffer().then(bytes => invoke('stage_file', bytes, { headers: { 'x-request-id': id } }));
// One request at a time: a second staged file would take the single Rust slot from the first.
function send(body: Body, keepOpen: boolean, stage?: Stage): void {
  if (pending || !state.online) return;
  pending = { id: relay(body, stage), kind: body.kind, keepOpen }; render();
}

function sendFavorite(favorite: Favorite, keepOpen: boolean): void {
  if (favorite.kind === 'gif') {
    if (state.gifSearch) send({ kind: 'gif', gif: favorite.gif }, keepOpen);
    else toast('Ce favori demande la recherche GIF du serveur, indisponible sur ce salon.', 'error');
  // Rust reads the local copy into the staging slot: the bytes never pass through this webview.
  } else send({ kind: 'file', name: `${favorite.name}.${favorite.ext}`, type: accepted[favorite.ext]! }, keepOpen, id => invoke('stage_favorite', { id, file: favoriteFile(favorite) }));
}

function starGif(index: number): void {
  const gif = gifs[index];
  if (!gif) return;
  const { id, previewUrl, width, height } = gif;
  // Named after the search that found it: the same words will find it among the favorites.
  send({ kind: 'favorite-gif', gif: { id, previewUrl, width, height }, name: (query.value.trim() || id).slice(0, 64) }, true);
}
function star(): void {
  if (file) send({ kind: 'favorite-file', name: file.name, type: file.type }, true, staged(file));
  else if (selected >= shown.length) starGif(selected - shown.length);
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
      renderGrid(results, gifs, (i, keepOpen) => send({ kind: 'gif', gif: gifs[i]!.id }, keepOpen), { star: starGif });
      stars(); select(loaded === 1 ? -1 : selected);
    }
  } else if (result.id === pending?.id) {
    const { kind, keepOpen } = pending; pending = undefined;
    if (!result.ok) toast(result.error, 'error');
    else if (kind.startsWith('favorite')) toast('Ajouté aux favoris.');
    else {
      if (kind === 'text') { query.value = ''; find(); void renderFavorites(); }
      if (kind === 'file') attach(undefined);
      if (keepOpen) toast(`${kind === 'gif' ? 'GIF envoyé' : kind === 'file' ? 'Fichier envoyé' : 'Message envoyé'} au salon.`); else hide();
    }
  } else return;
  render();
}

function submit(keepOpen: boolean): void {
  if (file) return send({ kind: 'file', name: file.name, type: file.type }, keepOpen, staged(file));
  const favorite = shown[selected];
  if (favorite) return sendFavorite(favorite, keepOpen);
  const gif = gifs[selected - shown.length];
  if (gif) return send({ kind: 'gif', gif: gif.id }, keepOpen);
  const text = query.value.trim();
  if (text) send({ kind: 'text', text }, keepOpen);
}

$<HTMLFormElement>('quick-form').onsubmit = event => event.preventDefault();
query.oninput = () => { select(-1); void renderFavorites(); clearTimeout(debounce); debounce = setTimeout(() => find(), 300); };
query.onkeydown = event => {
  if (event.isComposing) return;
  if (event.key === 'Enter') { event.preventDefault(); submit(event.ctrlKey); return; }
  if (event.ctrlKey && event.key.toLowerCase() === 'd') { event.preventDefault(); star(); return; }
  const counts = $('picks').hidden ? [] : [favorites.hidden ? 0 : shown.length, results.hidden ? 0 : gifs.length];
  const next = gridMove(selected, event, counts, getComputedStyle(favorites.hidden ? results : favorites).gridTemplateColumns.split(' ').length);
  if (next === undefined) return;
  event.preventDefault(); select(next);
};
$('file-star').onclick = star;
$('received-button').onclick = () => openReceived(!receivedOpen);
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
window.addEventListener('keydown', event => { if (event.key === 'Escape') { if (receivedOpen && !file) openReceived(false); else if (file) attach(undefined); else hide(); } });

if (isTauri()) {
  const target = { target: 'quick-send' };
  await listen<QuickSendState>('quick-send-state', event => setState(event.payload), target);
  await listen<QuickSendState>('quick-send-open', event => {
    receivedOpen = false; setState(event.payload); $('toasts').replaceChildren(); openReceived(false); query.select();
  }, target);
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
