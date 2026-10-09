import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { defaultSettings, settingsSchema, pairingRequestSchema, pairingResponseSchema, normalizeServerUrl, type MediaEvent } from '@dropmeme/shared';
import { Social } from './social.js';
import { DiscordIdentity } from './discord-identity.js';
import { initializeUpdates } from './updates.js';
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
const previews = new Set<string>();
let placing = false;
let connected = false;
const display = new Display();
const social = new Social(() => preferences);
const identity = new DiscordIdentity(() => preferences, save);
const queue = new MediaQueue(preferences.settings, media => {
  void display.show(media, preferences.settings).catch(async error => {
    message(error instanceof Error ? error.message : 'Affichage impossible.'); await display.hide(media.id); queue.complete(media.id);
  });
}, (pending, _active, count) => {
  $('queue-status').textContent = paused ? 'Réception en pause' : `${count ? `${count} média(s) à l’écran · ` : ''}${pending ? `${pending} en attente` : 'Aucun média en attente'}`;
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
  identity.render();
}

function startConnection(token: string): void {
  connection?.stop(); queue.reset(); paused = false; $('pause').textContent = 'Mettre en pause';
  connection = new Connection(preferences.server, token, event => {
    if (event.type === 'ready') {
      connected = true; status(event.discordConnected ? 'En direct' : 'Discord indisponible', event.discordConnected);
      social.setOnline(event.protocol === 2);
      identity.setOnline(event.protocol === 2, event.version);
      if (preferences.subscription && preferences.subscription.discordUserId !== event.discordUserId) {
        preferences.subscription.discordUserId = event.discordUserId;
        identity.render();
        void save().catch(() => message('Impossible d’enregistrer la liaison Discord.'));
      }
      message('');
    } else if (event.type === 'status') status(event.discordConnected ? 'En direct' : 'Discord indisponible', event.discordConnected);
    else if (event.type === 'media' && event.channelId === preferences.subscription?.channelId && !previewing && !placing) queue.enqueue(event);
    else if (event.type === 'presence') social.setPeers(event.peers);
    else if (event.type === 'error') message(event.message);
  }, state => {
    connected = false;
    social.setOnline(false);
    identity.setOnline(false);
    status(state === 'connecting' ? 'Connexion…' : state === 'offline' ? 'Reconnexion…' : 'Déconnecté');
    if (state === 'expired') message('Cet abonnement a été révoqué. Désabonnez-vous puis utilisez une nouvelle invitation.');
    if (state === 'duplicate') message('Cet appareil est déjà connecté dans une autre instance.');
  }, { name: preferences.settings.displayName, acceptDirect: preferences.settings.acceptDirect });
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
    preferences.subscription = { deviceId: result.deviceId, channelId: result.channelId, channelName: result.channelName, discordUserId: result.discordUserId };
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
    social.setOnline(false);
    identity.setOnline(false);
    queue.reset(); await display.hide(); await clearToken();
    preferences.subscription = undefined; await save(); subscriptionUi(); status('Déconnecté'); message('');
  } catch { message('Le serveur est inaccessible. Le jeton est conservé pour pouvoir révoquer l’abonnement au prochain essai.'); }
  finally { button.disabled = false; }
};

$('pause').onclick = () => {
  paused = !paused; queue.setPaused(paused); previewing = false; previews.clear();
  void display.hide(); $('pause').textContent = paused ? 'Reprendre' : 'Mettre en pause';
};
$('skip').onclick = async () => {
  const id = queue.currentId() ?? previews.values().next().value;
  if (id) { await display.hide(id); previews.delete(id); previewing = previews.size > 0; queue.complete(id); }
};
$('clear').onclick = () => { queue.clear(); previewing = false; previews.clear(); void display.hide(); };
$('hide').onclick = () => { if (isTauri()) void getCurrentWindow().hide(); else message('La réduction dans la zone de notification est disponible dans l’application desktop.'); };

$('preview').onclick = async () => {
  const id = queue.currentId(); if (id || previewing) { message('Passez ou videz les médias en cours avant de tester l’affichage.'); return; }
  previewing = true;
  const button = $<HTMLButtonElement>('preview'); button.disabled = true;
  message('Ouverture de la superposition…');
  const count = preferences.settings.multiDisplay ? (preferences.settings.multiPlacement === 'zones' ? Math.min(preferences.settings.maxSimultaneous, Math.max(1, preferences.settings.zones.length)) : preferences.settings.maxSimultaneous) : 1;
  try {
    await Promise.all(Array.from({ length: count }, async (_, i) => {
      const media: MediaEvent = { type: 'media', id: `preview-${Date.now()}-${i}`, channelId: '123456789012345678', kind: 'image', animation: true, url: new URL('/preview.gif', location.href).href, name: 'Aperçu DropMeme.gif', author: 'DropMeme', caption: 'Un texte peut accompagner vos médias.', createdAt: Date.now() };
      previews.add(media.id); await display.show(media, preferences.settings, true);
    })); message('');
  } catch (error) { previews.clear(); previewing = false; await display.hide(); message(error instanceof Error ? error.message : 'Aperçu impossible.'); }
  finally { button.disabled = placing; }
};

async function editPlacement(zoneId?: string): Promise<void> {
  if (placing) return;
  placing = true; previewing = false; queue.setPaused(true);
  previews.clear();
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.settings-panel input, .settings-panel select, .settings-panel button, #pause, #disconnect, #skip, #clear')];
  for (const control of controls) control.disabled = true;
  message('Déplacez le cadre sur votre écran et validez avec ✓. Les nouveaux médias sont ignorés pendant le placement.');
  try {
    await display.hide();
    const zone = preferences.settings.zones.find(item => item.id === zoneId);
    const base = zone ? { ...preferences.settings, monitor: zone.monitor, position: 'custom' as const, customX: zone.x, customY: zone.y, width: zone.width, height: zone.height } : preferences.settings;
    const result = await placeOverlay(base);
    if (result) {
      if (zoneId) {
        const nextZone = { id: zoneId, monitor: result.monitor, position: 'custom' as const, x: result.customX, y: result.customY, width: result.width, height: result.height };
        preferences.settings.zones = zone
          ? preferences.settings.zones.map(item => item.id === zoneId ? nextZone : item)
          : [...preferences.settings.zones, nextZone];
      } else preferences.settings = result;
      queue.configure(preferences.settings); await save();
      $('saved').textContent = 'Disposition enregistrée pour cet écran.';
    }
    message('');
  } catch (error) { message(error instanceof Error ? error.message : 'Placement impossible.'); }
  finally {
    placing = false; queue.setPaused(paused);
    for (const control of controls) control.disabled = false;
    renderSettings();
  }
}
$('place').onclick = () => { void editPlacement(); };
$('add-zone').onclick = () => { if (preferences.settings.zones.length < 8) void editPlacement(crypto.randomUUID()); };

const numbers = ['width', 'height', 'durationSeconds', 'gifDurationSeconds', 'videoDurationSeconds', 'maxSimultaneous', 'volume', 'opacity', 'maxQueue'] as const;
const booleans = ['sound', 'images', 'videos', 'audio', 'texts', 'acceptDirect', 'showAuthor', 'multiDisplay', 'startMinimized'] as const;
function renderSettings(): void {
  for (const key of numbers) input(key).value = String(preferences.settings[key]);
  for (const key of booleans) input(key).checked = preferences.settings[key];
  $<HTMLSelectElement>('position').value = preferences.settings.position;
  $<HTMLSelectElement>('monitor').value = preferences.settings.monitor;
  $('opacity-value').textContent = `${preferences.settings.opacity}%`;
  $('volume-value').textContent = `${preferences.settings.volume}%`;
  input('volume').disabled = !preferences.settings.sound;
  input('displayName').value = preferences.settings.displayName;
  $<HTMLSelectElement>('multiPlacement').value = preferences.settings.multiPlacement;
  $<HTMLSelectElement>('captionPosition').value = preferences.settings.captionPosition;
  $('multi-fields').hidden = !preferences.settings.multiDisplay;
  $('zones-fields').hidden = preferences.settings.multiPlacement !== 'zones';
  $('zones-list').replaceChildren();
  for (const [i, zone] of preferences.settings.zones.entries()) {
    const row = document.createElement('li'); const label = document.createElement('span');
    label.textContent = `Zone ${i + 1} · ${zone.width} × ${zone.height} · ${zone.monitor}`;
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Placer'; edit.onclick = () => { void editPlacement(zone.id); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Supprimer'; remove.onclick = () => {
      queue.clear(); previews.clear(); previewing = false; void display.hide();
      preferences.settings.zones = preferences.settings.zones.filter(item => item.id !== zone.id); renderSettings(); void save();
    };
    row.append(label, edit, remove); $('zones-list').append(row);
  }
  $<HTMLButtonElement>('add-zone').disabled = preferences.settings.zones.length >= 8;
}

for (const key of [...numbers, ...booleans, 'position', 'monitor', 'displayName', 'multiPlacement', 'captionPosition']) {
  $(key).addEventListener('change', () => {
    let next = { ...preferences.settings };
    for (const name of numbers) next[name] = Number(input(name).value);
    for (const name of booleans) next[name] = input(name).checked;
    next.position = $<HTMLSelectElement>('position').value as typeof next.position;
    next.monitor = $<HTMLSelectElement>('monitor').value;
    next.displayName = input('displayName').value.trim();
    next.multiPlacement = $<HTMLSelectElement>('multiPlacement').value as typeof next.multiPlacement;
    next.captionPosition = $<HTMLSelectElement>('captionPosition').value as typeof next.captionPosition;
    if (key === 'monitor') next = settingsForMonitor(next, next.monitor);
    next.layouts = { ...next.layouts, [next.monitor]: { position: next.position, x: next.customX, y: next.customY, width: next.width, height: next.height } };
    const result = settingsSchema.safeParse(next);
    if (!result.success) { message('Réglage hors limites.'); renderSettings(); return; }
    const geometryChanged = ['width', 'height', 'position', 'monitor', 'multiPlacement', 'multiDisplay', 'maxSimultaneous'].includes(key);
    if (geometryChanged) { queue.clear(); previews.clear(); previewing = false; void display.hide(); }
    preferences.settings = result.data; queue.configure(result.data); renderSettings();
    display.updateSettings(result.data);
    if (key === 'displayName' || key === 'acceptDirect') connection?.setProfile({ name: result.data.displayName, acceptDirect: result.data.acceptDirect });
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
    if (!queue.has(id) && !previews.has(id)) return;
    void display.hide(id).then(() => {
      if (previews.delete(id)) previewing = previews.size > 0;
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
  initializeUpdates();
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
