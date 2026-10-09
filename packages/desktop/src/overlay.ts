import { isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mediaEventSchema, settingsSchema, playbackDuration, type Settings } from '@dropmeme/shared';
import type { DisplayPayload } from './display.js';
import './overlay.css';

const root = document.querySelector<HTMLDivElement>('#media-root')!;
interface Playing { container: HTMLDivElement; author: HTMLElement; loaded: boolean; texts: boolean; caption?: HTMLElement; player?: HTMLMediaElement; timer?: ReturnType<typeof setTimeout>; loading?: ReturnType<typeof setTimeout> }
const playing = new Map<string, Playing>();

function stop(id?: string): void {
  for (const [key, value] of playing) if (!id || key === id) {
    clearTimeout(value.timer); clearTimeout(value.loading);
    if (value.player) { value.player.pause(); value.player.removeAttribute('src'); value.player.load(); }
    value.container.remove(); playing.delete(key);
  }
}
function done(id: string, error?: string): void {
  if (!playing.has(id)) return;
  stop(id); const payload = error ? { id, error } : { id };
  if (isTauri()) void emitTo('main', 'overlay-done', payload);
  else parent.postMessage({ type: 'overlay-done', ...payload }, location.origin);
}
function configure(settings: Settings): void {
  for (const value of playing.values()) {
    value.container.style.opacity = String(settings.opacity / 100); value.author.hidden = !settings.showAuthor;
    value.container.dataset.captionPosition = settings.captionPosition;
    value.texts = settings.texts;
    if (value.caption) value.caption.hidden = !value.loaded || !settings.texts;
    if (value.player) { value.player.muted = !settings.sound; value.player.volume = settings.volume / 100; }
  }
}
function play(payload: DisplayPayload): void {
  const parsed = mediaEventSchema.safeParse(payload?.media); const configured = settingsSchema.safeParse(payload?.settings);
  if (!parsed.success || !configured.success) return;
  const media = parsed.data; const settings = configured.data; const url = new URL(media.url);
  if (!(payload.preview && url.origin === location.origin && url.pathname === '/preview.gif') && !url.pathname.startsWith('/v1/media/')) return;
  if (!['http:', 'https:', 'tauri:'].includes(url.protocol)) return;
  if (!payload.box || !Object.values(payload.box).every(Number.isFinite)) return;
  stop(media.id);
  const container = document.createElement('div'); container.className = 'media-item'; container.dataset.mediaId = media.id;
  container.dataset.captionPosition = settings.captionPosition;
  Object.assign(container.style, { left: `${payload.box.x}px`, top: `${payload.box.y}px`, width: `${payload.box.width}px`, height: `${payload.box.height}px`, opacity: String(settings.opacity / 100) });
  const content = document.createElement('div'); content.className = 'media-content'; container.append(content);
  const author = document.createElement('div'); author.className = 'media-author'; author.textContent = `De ${media.author}`; author.hidden = !settings.showAuthor;
  const value: Playing = { container, author, loaded: false, texts: settings.texts }; playing.set(media.id, value);
  const loaded = () => {
    if (playing.get(media.id) !== value) return;
    clearTimeout(value.loading);
    value.loaded = true;
    if (value.caption) value.caption.hidden = !value.texts;
    if (!value.timer) value.timer = setTimeout(() => done(media.id), playbackDuration(media, settings) * 1000);
  };
  value.loading = setTimeout(() => done(media.id, 'Chargement du média trop long.'), media.kind === 'video' ? 60_000 : 15_000);
  if (media.kind === 'text') {
    const text = document.createElement('div'); text.className = 'text-tile'; text.textContent = media.text!;
    content.append(text); loaded();
  } else if (media.kind === 'image') {
    const image = document.createElement('img'); image.alt = media.name;
    image.onload = loaded; image.onerror = () => { if (playing.get(media.id) === value) done(media.id, 'Image non lisible.'); };
    image.src = media.url; content.append(image);
  } else {
    const element = document.createElement(media.kind === 'video' ? 'video' : 'audio'); value.player = element;
    element.muted = !settings.sound; element.volume = settings.volume / 100; element.autoplay = true; element.preload = 'auto';
    element.loop = media.kind === 'video' && media.loop === true;
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    element.onended = () => { if (playing.get(media.id) === value) done(media.id); };
    element.onerror = () => { if (playing.get(media.id) === value) done(media.id, 'Format non pris en charge ou conversion échouée.'); };
    element.onloadeddata = () => {
      if (playing.get(media.id) !== value) return;
      loaded(); void element.play().catch(() => { if (playing.get(media.id) === value) done(media.id, 'Lecture automatique refusée. Vérifiez les réglages du son.'); });
    };
    element.src = media.url;
    if (media.kind === 'audio') { const tile = document.createElement('div'); tile.className = 'audio-tile'; tile.textContent = `♪ ${media.name}`; tile.append(element); content.append(tile); }
    else content.append(element);
  }
  content.append(author);
  if (media.caption && media.kind !== 'text') {
    const caption = document.createElement('div'); caption.className = 'media-caption'; caption.textContent = media.caption;
    caption.hidden = !value.loaded || !value.texts; value.caption = caption; container.append(caption);
  }
  root.append(container);
}

if (isTauri()) {
  const label = getCurrentWindow().label; const target = { target: label };
  await listen<DisplayPayload>('overlay-play', event => play(event.payload), target);
  await listen<{ id?: string }>('overlay-stop', event => stop(event.payload?.id), target);
  await listen<Settings>('overlay-settings', event => { const settings = settingsSchema.safeParse(event.payload); if (settings.success) configure(settings.data); }, target);
  await listen('overlay-probe', () => { void emitTo('main', 'overlay-ready', { label }); }, target);
  await emitTo('main', 'overlay-ready', { label });
} else {
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent) return;
    const data = event.data as { type?: string; payload?: unknown };
    if (data?.type === 'overlay-play') play(data.payload as DisplayPayload);
    if (data?.type === 'overlay-stop') stop((data.payload as { id?: string } | undefined)?.id);
    if (data?.type === 'overlay-settings') { const settings = settingsSchema.safeParse(data.payload); if (settings.success) configure(settings.data); }
  });
}
