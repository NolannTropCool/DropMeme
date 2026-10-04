import { isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { mediaEventSchema, settingsSchema } from '@dropmeme/shared';
import type { DisplayPayload } from './display.js';
import './overlay.css';

const root = document.querySelector<HTMLDivElement>('#media-root')!;
let timer: ReturnType<typeof setTimeout> | undefined;
let loading: ReturnType<typeof setTimeout> | undefined;
let active: HTMLVideoElement | HTMLAudioElement | undefined;
let id: string | undefined;
let generation = 0;

function stop(): void {
  generation++; clearTimeout(timer); clearTimeout(loading);
  if (active) { active.pause(); active.removeAttribute('src'); active.load(); active = undefined; }
  root.replaceChildren(); id = undefined;
}

function done(error?: string): void {
  if (!id) return;
  const finished = id; stop();
  const payload = error ? { id: finished, error } : { id: finished };
  if (isTauri()) void emitTo('main', 'overlay-done', payload);
  else parent.postMessage({ type: 'overlay-done', ...payload }, location.origin);
}

function play(payload: DisplayPayload): void {
  const mediaResult = mediaEventSchema.safeParse(payload?.media);
  const settingsResult = settingsSchema.safeParse(payload?.settings);
  if (!mediaResult.success || !settingsResult.success) return;
  const media = mediaResult.data;
  const settings = settingsResult.data;
  const url = new URL(media.url);
  // Preview is a bundled asset. All other media are authenticated server resources.
  if (!(payload.preview && url.origin === location.origin && url.pathname === '/preview.svg') && !url.pathname.startsWith('/v1/media/')) return;
  if (!['http:', 'https:', 'tauri:'].includes(url.protocol)) return;
  stop(); id = media.id;
  const current = generation;
  root.style.opacity = String(settings.opacity / 100);
  loading = setTimeout(() => done('Chargement du média trop long.'), 10_000);
  const loaded = () => {
    if (current !== generation) return;
    clearTimeout(loading);
    timer = setTimeout(() => done(), settings.durationSeconds * 1000);
  };
  if (media.kind === 'image') {
    const image = document.createElement('img'); image.alt = media.name;
    image.onload = loaded; image.onerror = () => { if (current === generation) done('Image non lisible.'); };
    image.src = media.url; root.append(image);
  } else {
    const element = document.createElement(media.kind === 'video' ? 'video' : 'audio');
    active = element; element.muted = !settings.sound; element.volume = settings.volume / 100;
    element.autoplay = true; element.preload = 'auto';
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    element.onended = () => { if (current === generation) done(); };
    element.onerror = () => { if (current === generation) done('Format non pris en charge par cet appareil.'); };
    element.onloadeddata = () => {
      if (current !== generation) return;
      loaded();
      void element.play().catch(() => { if (current === generation) done('Lecture automatique refusée. Vérifiez les réglages du son.'); });
    };
    element.src = media.url;
    if (media.kind === 'audio') {
      const tile = document.createElement('div'); tile.className = 'audio-tile';
      const symbol = document.createElement('span'); symbol.textContent = '♪'; symbol.className = 'audio-symbol';
      const name = document.createElement('strong'); name.textContent = media.name;
      const author = document.createElement('span'); author.textContent = media.author;
      tile.append(symbol, name, author, element); root.append(tile);
    } else root.append(element);
  }
}

if (isTauri()) {
  await listen<DisplayPayload>('overlay-play', event => play(event.payload));
  await listen('overlay-stop', stop);
  await emitTo('main', 'overlay-ready');
} else {
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent) return;
    const data = event.data as { type?: string; payload?: DisplayPayload };
    if (data?.type === 'overlay-play' && data.payload) play(data.payload);
    if (data?.type === 'overlay-stop') stop();
  });
}
