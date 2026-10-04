import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { defaultSettings, settingsSchema, pairingRequestSchema, pairingResponseSchema, normalizeServerUrl, type MediaEvent } from '@dropmeme/shared';
import { Display } from './display.js';
import { MediaQueue } from './queue.js';
import { Connection } from './connection.js';
import { placeOverlay } from './placement-controller.js';
import { settingsForMonitor } from './geometry.js';
import { readPreferences, writePreferences, readToken, saveToken, clearToken, type Preferences } from './preferences.js';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const message = (text: string) => { $('message').textContent = text; };
let preferences: Preferences = { settings: { ...defaultSettings }, server: '', subscription: undefined };
let connection: Connection | undefined;
let mode: 'code' | 'channel' = 'code';
let paused = false;
let previewing = false;
let placing = false;
let connected = false;
const display = new Display();
const queue = new MediaQueue(preferences.settings, media => {
  void display.show(media, preferences.settings).catch(error => {
    message(error instanceof Error ? error.message : 'Affichage impossible.'); queue.complete(media.id);
  });
}, (pending, active) => {
  $('queue-status').textContent = paused ? 'Réception en pause' : `${active ? 'Un média à l’écran · ' : ''}${pending ? `${pending} en attente` : 'Aucun média en attente'}`;
});

function status(text: string, online = false): void {
  $('status').textContent = text; $('status-dot').classList.toggle('online', online);
}

let saves: Promise<void> = Promise.resolve();
function save(): Promise<void> {
  const snapshot = structuredClone(preferences);
  saves = saves.catch(() => {}).then(() => writePreferences(snapshot));
  return saves;
}

function subscriptionUi(): void {
  $('connect-form').hidden = !!preferences.subscription;
  $('subscription').hidden = !preferences.subscription;
  $('channel-name').textContent = preferences.subscription?.channelName ?? '';
  $('channel-id').textContent = preferences.subscription?.channelId ?? '';
}

function startConnection(token: string): void {
  connection?.stop(); queue.reset(); paused = false; $('pause').textContent = 'Mettre en pause';
  connection = new Connection(preferences.server, token, event => {
    if (event.type === 'ready') {
      connected = true; status(event.discordConnected ? 'En direct' : 'Discord indisponible', event.discordConnected);
      message('');
    } else if (event.type === 'status') status(event.discordConnected ? 'En direct' : 'Discord indisponible', event.discordConnected);
    else if (event.type === 'media' && event.channelId === preferences.subscription?.channelId && !previewing && !placing) queue.enqueue(event);
    else if (event.type === 'error') message(event.message);
  }, state => {
    connected = false;
    status(state === 'connecting' ? 'Connexion…' : state === 'offline' ? 'Reconnexion…' : 'Déconnecté');
    if (state === 'expired') message('Cet abonnement a été révoqué. Désabonnez-vous puis utilisez une nouvelle invitation.');
    if (state === 'duplicate') message('Cet appareil est déjà connecté dans une autre instance.');
  });
  connection.start(); subscriptionUi();
}

function setMode(value: 'code' | 'channel'): void {
  mode = value; $('code-fields').hidden = value !== 'code'; $('channel-fields').hidden = value !== 'channel';
  for (const name of ['code', 'channel'] as const) {
    $(`mode-${name}`).classList.toggle('active', name === value);
    $(`mode-${name}`).setAttribute('aria-pressed', String(name === value));
  }
}
$('mode-code').onclick = () => setMode('code');
$('mode-channel').onclick = () => setMode('channel');

$<HTMLFormElement>('connect-form').onsubmit = async event => {
  event.preventDefault();
  const button = $<HTMLButtonElement>('connect'); button.disabled = true; message('');
  try {
    const server = normalizeServerUrl(input('server').value);
    const body = mode === 'code' ? { code: input('code').value.trim().toUpperCase() } : { channelId: input('channel').value.trim(), joinKey: input('join-key').value };
    if (!pairingRequestSchema.safeParse(body).success) throw new Error(mode === 'code' ? 'Saisissez le code complet XXXXXXXX-XXXXXXXX.' : 'Vérifiez l’ID du salon et la clé d’invitation (24 caractères minimum).');
    const response = await fetch(`${server}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Invitation invalide ou expirée.' : response.status === 429 ? 'Trop de tentatives. Réessayez dans une minute.' : 'Le serveur a refusé la connexion.');
    const result = pairingResponseSchema.parse(await response.json());
    try { await saveToken(result.token); }
    catch (error) {
      // Do not leave an active server credential if local secure storage fails.
      await fetch(`${server}/v1/device`, { method: 'DELETE', headers: { Authorization: `Bearer ${result.token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
      throw error;
    }
    preferences.server = server;
    preferences.subscription = { deviceId: result.deviceId, channelId: result.channelId, channelName: result.channelName };
    await save(); input('code').value = ''; input('join-key').value = '';
    startConnection(result.token);
  } catch (error) { message(error instanceof Error ? error.message : 'Connexion impossible.'); }
  finally { button.disabled = false; }
};

$('disconnect').onclick = async () => {
  const button = $<HTMLButtonElement>('disconnect'); button.disabled = true;
  try {
    const token = await readToken();
    if (token) {
      const response = await fetch(`${preferences.server}/v1/device`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok && response.status !== 401) throw new Error('Le serveur n’a pas confirmé le désabonnement.');
    }
    connection?.stop(); connection = undefined; connected = false;
    queue.reset(); await display.hide(); await clearToken();
    preferences.subscription = undefined; await save(); subscriptionUi(); status('Déconnecté'); message('');
  } catch { message('Le serveur est inaccessible. Le jeton est conservé pour pouvoir révoquer l’abonnement au prochain essai.'); }
  finally { button.disabled = false; }
};

$('pause').onclick = () => {
  paused = !paused; queue.setPaused(paused); previewing = false;
  void display.hide(); $('pause').textContent = paused ? 'Reprendre' : 'Mettre en pause';
};
$('skip').onclick = async () => {
  const id = queue.currentId(); previewing = false; await display.hide(); if (id) queue.complete(id);
};
$('clear').onclick = () => { queue.clear(); previewing = false; void display.hide(); };
$('hide').onclick = () => { if (isTauri()) void getCurrentWindow().hide(); else message('La réduction dans la zone de notification est disponible dans l’application desktop.'); };

$('preview').onclick = async () => {
  const id = queue.currentId(); if (id) { message('Passez le média en cours avant de tester l’affichage.'); return; }
  previewing = true;
  const button = $<HTMLButtonElement>('preview'); button.disabled = true;
  message('Ouverture de la superposition…');
  const media: MediaEvent = { type: 'media', id: `preview-${Date.now()}`, channelId: '123456789012345678', kind: 'image', url: new URL('/preview.gif', location.href).href, name: 'Aperçu DropMeme', author: 'DropMeme', createdAt: Date.now() };
  try { await display.show(media, preferences.settings, true); message(''); }
  catch (error) { previewing = false; message(error instanceof Error ? error.message : 'Aperçu impossible.'); }
  finally { button.disabled = placing; }
};

$('place').onclick = async () => {
  if (placing) return;
  placing = true; previewing = false; queue.setPaused(true);
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.settings-panel input, .settings-panel select, .settings-panel button, #pause, #disconnect, #skip, #clear')];
  for (const control of controls) control.disabled = true;
  message('Déplacez le cadre sur votre écran et validez avec ✓. Les nouveaux médias sont ignorés pendant le placement.');
  try {
    await display.hide();
    const result = await placeOverlay(preferences.settings);
    if (result) {
      preferences.settings = result; queue.configure(result); await save();
      $('saved').textContent = 'Disposition enregistrée pour cet écran.';
    }
    message('');
  } catch (error) { message(error instanceof Error ? error.message : 'Placement impossible.'); }
  finally {
    placing = false; queue.setPaused(paused);
    for (const control of controls) control.disabled = false;
    renderSettings();
  }
};

const numbers = ['width', 'height', 'durationSeconds', 'volume', 'opacity', 'maxQueue'] as const;
const booleans = ['sound', 'images', 'videos', 'audio', 'startMinimized'] as const;
function renderSettings(): void {
  for (const key of numbers) input(key).value = String(preferences.settings[key]);
  for (const key of booleans) input(key).checked = preferences.settings[key];
  $<HTMLSelectElement>('position').value = preferences.settings.position;
  $<HTMLSelectElement>('monitor').value = preferences.settings.monitor;
  $('opacity-value').textContent = `${preferences.settings.opacity}%`;
  $('volume-value').textContent = `${preferences.settings.volume}%`;
  input('volume').disabled = !preferences.settings.sound;
}

for (const key of [...numbers, ...booleans, 'position', 'monitor']) {
  $(key).addEventListener('change', () => {
    let next = { ...preferences.settings };
    for (const name of numbers) next[name] = Number(input(name).value);
    for (const name of booleans) next[name] = input(name).checked;
    next.position = $<HTMLSelectElement>('position').value as typeof next.position;
    next.monitor = $<HTMLSelectElement>('monitor').value;
    if (key === 'monitor') next = settingsForMonitor(next, next.monitor);
    next.layouts = { ...next.layouts, [next.monitor]: { position: next.position, x: next.customX, y: next.customY, width: next.width, height: next.height } };
    const result = settingsSchema.safeParse(next);
    if (!result.success) { message('Réglage hors limites.'); renderSettings(); return; }
    preferences.settings = result.data; queue.configure(result.data); renderSettings();
    const current = queue.currentId();
    // Apply new playback settings by ending the active media; never leave old sound playing.
    if (current || previewing) { previewing = false; void display.hide().then(() => { if (current) queue.complete(current); }); }
    void save().then(() => { $('saved').textContent = 'Réglages enregistrés.'; }).catch(() => { $('saved').textContent = 'Enregistrement impossible.'; });
  });
}
input('opacity').oninput = () => { $('opacity-value').textContent = `${input('opacity').value}%`; };
input('volume').oninput = () => { $('volume-value').textContent = `${input('volume').value}%`; };
input('autostart').onchange = async () => {
  if (!isTauri()) { input('autostart').checked = false; message('Le démarrage automatique est disponible dans l’application desktop.'); return; }
  try { if (input('autostart').checked) await enable(); else await disable(); }
  catch { input('autostart').checked = !input('autostart').checked; message('Impossible de modifier le démarrage automatique.'); }
};

async function initialize(): Promise<void> {
  try { preferences = await readPreferences(); }
  catch { message('Les préférences ne peuvent pas être chargées. Réglages par défaut appliqués.'); }
  queue.configure(preferences.settings);
  input('server').value = preferences.server;
  await display.initialize((id, error) => {
    if (id !== queue.currentId() && !(previewing && id.startsWith('preview-'))) return;
    void display.hide().then(() => {
      if (previewing && id.startsWith('preview-')) previewing = false;
      else queue.complete(id);
      if (error) message(error);
    });
  });
  const monitors = await display.monitors();
  // 0.1.0 saved enumeration indices. Convert once to the stable display name.
  if (/^\d+$/.test(preferences.settings.monitor)) preferences.settings.monitor = monitors[Number(preferences.settings.monitor)]?.value ?? 'primary';
  for (const monitor of monitors) {
    const option = document.createElement('option'); option.value = monitor.value; option.textContent = monitor.label; $('monitor').append(option);
  }
  if (![...$<HTMLSelectElement>('monitor').options].some(option => option.value === preferences.settings.monitor)) preferences.settings.monitor = 'primary';
  renderSettings(); subscriptionUi();
  if (isTauri()) {
    input('autostart').checked = await isEnabled();
    await getCurrentWindow().onCloseRequested(event => { event.preventDefault(); void getCurrentWindow().hide(); });
  }
  const token = await readToken();
  if (preferences.subscription && token) startConnection(token);
  else if (preferences.subscription) { preferences.subscription = undefined; await save(); subscriptionUi(); }
  if (isTauri() && preferences.settings.startMinimized) await getCurrentWindow().hide();
}
void initialize().catch(error => message(error instanceof Error ? error.message : 'Initialisation impossible.'));
window.addEventListener('online', () => { if (!connected && connection) { connection.stop(); connection.start(); } });
