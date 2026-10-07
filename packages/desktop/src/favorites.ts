import { invoke, isTauri } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import { favoriteExtension, favoriteSchema, type Favorite, type FavoriteExtension, type GifResult, type MediaEvent } from '@dropmeme/shared';
import { accepted, formatSize, mediaElement } from './picker.js';
import { toast } from './toast.js';

export const maxFavorites = 200;
export const maxFavoriteBytes = 500 * 1024 * 1024;
export type FileFavorite = Extract<Favorite, { kind: 'file' }>;
export type ReceivedMedia = Pick<MediaEvent, 'id' | 'kind' | 'url' | 'name' | 'author'>;

/** Entries read from disk: an invalid or duplicate one is dropped, never the whole list. */
export function parseFavorites(raw: unknown): Favorite[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  return raw.flatMap(item => {
    const favorite = favoriteSchema.safeParse(item);
    if (!favorite.success || ids.has(favorite.data.id)) return [];
    ids.add(favorite.data.id); return [favorite.data];
  }).slice(0, maxFavorites);
}

export const favoriteBytes = (list: readonly Favorite[]): number => list.reduce((sum, favorite) => sum + (favorite.kind === 'file' ? favorite.size : 0), 0);

/** French reason one more favorite of `size` bytes would pass the caps, or undefined. */
export function favoriteRefusal(list: readonly Favorite[], size = 0): string | undefined {
  if (list.length >= maxFavorites) return `${maxFavorites} favoris maximum. Supprimez-en dans l’onglet Favoris.`;
  if (favoriteBytes(list) + size > maxFavoriteBytes) return `Espace des favoris plein (${formatSize(maxFavoriteBytes)} maximum). Supprimez-en dans l’onglet Favoris.`;
  return undefined;
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** By name, ignoring case and accents; everything for an empty query. */
export function filterFavorites(list: readonly Favorite[], query: string): Favorite[] {
  const needle = fold(query.trim());
  return list.filter(favorite => fold(favorite.name).includes(needle));
}

export function moveFavorite(list: readonly Favorite[], id: string, delta: number): Favorite[] {
  const from = list.findIndex(favorite => favorite.id === id); const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const next = [...list]; next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** The 5 latest images, GIFs and videos, newest first. Text and audio cannot become favorites. */
export function rememberReceived(list: readonly ReceivedMedia[], media: MediaEvent): ReceivedMedia[] {
  if (media.kind !== 'image' && media.kind !== 'video') return [...list];
  const { id, kind, url, name, author } = media;
  return [{ id, kind, url, name, author }, ...list.filter(item => item.id !== id)].slice(0, 5);
}

/** Extension kept on disk, from the MIME type first: Windows may give none or a generic one. */
export function favoriteExtensionOf(type: string, name: string): FavoriteExtension | undefined {
  const extension = name.split('.').at(-1)!.toLowerCase();
  return favoriteExtension.options.find(value => accepted[value] === type) ?? favoriteExtension.options.find(value => value === extension);
}
const favoriteName = (name: string) => name.replace(/\.[^.]*$/, '').trim().slice(0, 64).trim() || 'Favori';
export const favoriteFile = (favorite: FileFavorite): string => `${favorite.id}.${favorite.ext}`;
export const isVideo = (extension: FavoriteExtension): boolean => accepted[extension]!.startsWith('video/');

const previews = new Map<string, Promise<string>>();
/**
 * Object URL of a file favorite, read once per webview through Rust.
 * ponytail: every shown favorite is loaded and kept (500 MB cap per webview at worst); load on scroll if memory matters.
 */
export function favoritePreview(favorite: FileFavorite): Promise<string> {
  let url = previews.get(favorite.id);
  if (!url) {
    url = invoke<ArrayBuffer>('favorite_read', { file: favoriteFile(favorite) }).then(bytes => URL.createObjectURL(new Blob([bytes], { type: accepted[favorite.ext]! })));
    url.catch(() => previews.delete(favorite.id));
    previews.set(favorite.id, url);
  }
  return url;
}
export function forgetPreview(id: string): void {
  void previews.get(id)?.then(URL.revokeObjectURL, () => {});
  previews.delete(id);
}
export function favoriteThumb(favorite: Favorite): HTMLImageElement | HTMLVideoElement {
  if (favorite.kind === 'gif') return mediaElement(favorite.previewUrl, /\.mp4$/i.test(new URL(favorite.previewUrl).pathname));
  const media = mediaElement('', isVideo(favorite.ext)); media.removeAttribute('src');
  void favoritePreview(favorite).then(url => { media.src = url; }, () => {});
  return media;
}

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = () => load('favorites.json', { defaults: {}, autoSave: false });

/** Main window owns the list: it alone writes the store and the files, then pushes the list to quick-send. */
export class Favorites {
  list: Favorite[] = [];
  received: ReceivedMedia[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly changed: () => void) {}

  async initialize(): Promise<void> {
    if (!isTauri()) { element('favorites-usage').textContent = 'Les favoris sont disponibles dans l’application Windows.'; return; }
    this.list = parseFavorites(await (await store()).get<unknown>('favorites'));
    this.render(); this.changed();
  }

  receive(media: MediaEvent): void { this.received = rememberReceived(this.received, media); this.changed(); }
  retract(ids: readonly string[]): void { this.received = this.received.filter(item => !ids.includes(item.id)); this.changed(); }

  addGif(gif: Omit<GifResult, 'url'>, name: string): Promise<void> {
    return this.serial(async () => {
      if (this.list.some(favorite => favorite.kind === 'gif' && favorite.gif === gif.id)) throw new Error('Ce GIF est déjà dans vos favoris.');
      const refusal = favoriteRefusal(this.list); if (refusal) throw new Error(refusal);
      await this.commit([{ id: crypto.randomUUID(), kind: 'gif', name: name.trim().slice(0, 64), gif: gif.id, previewUrl: gif.previewUrl, width: gif.width, height: gif.height }, ...this.list]);
    });
  }

  /** A local copy: the favorite outlives the 30-minute media ticket and the Discord message. */
  addFile(bytes: ArrayBuffer, type: string, name: string): Promise<void> {
    return this.serial(async () => {
      const ext = favoriteExtensionOf(type, name);
      if (!ext) throw new Error('Format refusé pour les favoris. Utilisez une image, un GIF, WebP, MP4 ou WebM.');
      if (!bytes.byteLength) throw new Error('Ce fichier est vide.');
      const refusal = favoriteRefusal(this.list, bytes.byteLength); if (refusal) throw new Error(refusal);
      const favorite: FileFavorite = { id: crypto.randomUUID(), kind: 'file', name: favoriteName(name), ext, size: bytes.byteLength };
      await invoke('favorite_write', bytes, { headers: { 'x-favorite': favoriteFile(favorite) } });
      try { await this.commit([favorite, ...this.list]); }
      catch (error) { await invoke('favorite_delete', { file: favoriteFile(favorite) }).catch(() => {}); throw error; }
    });
  }

  /** Downloads now, through the ticket main received: it expires after 30 minutes. */
  async addReceived(id: string): Promise<void> {
    const media = this.received.find(item => item.id === id);
    if (!media) throw new Error('Ce média ne fait plus partie des derniers reçus.');
    const response = await fetch(media.url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
    if (!response?.ok) throw new Error(response?.status === 401 ? 'Le lien de ce média a expiré (30 minutes). Il ne peut plus être ajouté.' : 'Le média ne peut pas être téléchargé.');
    await this.addFile(await response.arrayBuffer(), response.headers.get('content-type')?.split(';')[0]!.trim() ?? '', media.name);
  }

  private remove(id: string): Promise<void> {
    return this.serial(async () => {
      const favorite = this.list.find(item => item.id === id);
      await this.commit(this.list.filter(item => item.id !== id));
      // ponytail: a failed delete leaves an orphan file outside the count; sweep the folder if it ever matters.
      if (favorite?.kind === 'file') { forgetPreview(id); await invoke('favorite_delete', { file: favoriteFile(favorite) }); }
    });
  }

  private rename(id: string, value: string): Promise<void> {
    const name = value.trim();
    if (!name || name.length > 64) { this.render(); return Promise.reject(new Error('Le nom doit contenir de 1 à 64 caractères.')); }
    return this.serial(() => this.commit(this.list.map(item => item.id === id ? { ...item, name } : item)));
  }

  private move(id: string, delta: number): Promise<void> { return this.serial(() => this.commit(moveFavorite(this.list, id, delta))); }

  /** One change at a time: caps are checked against the list the change will extend. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => {}).then(task);
    this.tail = run; return run;
  }

  private async commit(list: Favorite[]): Promise<void> {
    const favorites = await store();
    await favorites.set('favorites', list); await favorites.save();
    this.list = list; this.render(); this.changed();
  }

  private run(task: () => Promise<void>): void { void task().catch((error: unknown) => toast(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Modification impossible.', 'error')); }

  private render(): void {
    const list = element('favorites-list');
    const bytes = favoriteBytes(this.list);
    element('favorites-usage').textContent = `${this.list.length} favori${this.list.length > 1 ? 's' : ''} sur ${maxFavorites} · ${bytes ? formatSize(bytes) : '0 Ko'} sur ${formatSize(maxFavoriteBytes)}.`;
    element('favorites-empty').hidden = this.list.length > 0;
    // Re-rendering replaces the rows: keep the keyboard focus on the same control of the same favorite.
    const active = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
    const focus = active && { id: active.closest('li')?.dataset.id, action: active.dataset.action, index: [...list.children].indexOf(active.closest('li')!) };
    list.replaceChildren(...this.list.map((favorite, i) => {
      const row = document.createElement('li'); row.dataset.id = favorite.id;
      const name = Object.assign(document.createElement('input'), { value: favorite.name, maxLength: 64 });
      name.ariaLabel = `Nom du favori ${i + 1}`; name.dataset.action = 'name';
      name.onchange = () => this.run(() => this.rename(favorite.id, name.value));
      const detail = document.createElement('span'); detail.className = 'favorite-detail';
      detail.textContent = favorite.kind === 'gif' ? 'GIF Klipy' : `${favorite.ext.toUpperCase()} · ${formatSize(favorite.size)}`;
      const button = (action: string, text: string, disabled: boolean, task: () => Promise<void>) => {
        const control = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: text, disabled });
        control.ariaLabel = `${text} « ${favorite.name} »`; control.dataset.action = action; control.onclick = () => this.run(task);
        return control;
      };
      row.append(favoriteThumb(favorite), name, detail,
        button('up', 'Monter', i === 0, () => this.move(favorite.id, -1)),
        button('down', 'Descendre', i === this.list.length - 1, () => this.move(favorite.id, 1)),
        button('remove', 'Supprimer', false, () => this.remove(favorite.id)));
      return row;
    }));
    if (!focus) return;
    // A deleted favorite hands the focus to the one that took its place.
    const row = list.querySelector(`[data-id="${focus.id}"]`) ?? list.children[Math.min(focus.index, list.children.length - 1)];
    (row?.querySelector<HTMLElement>(`[data-action="${focus.action}"]:not(:disabled)`) ?? row?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
  }
}
