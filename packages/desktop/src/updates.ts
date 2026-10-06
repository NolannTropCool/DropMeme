import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { appVersion } from '@dropmeme/shared';
import { changelog } from './changelog.js';

export function initializeUpdates(): void {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  element('app-version').textContent = appVersion;
  for (const release of changelog) {
    const title = document.createElement('h3'); title.textContent = release.version;
    const list = document.createElement('ul');
    for (const change of release.changes) { const item = document.createElement('li'); item.textContent = change; list.append(item); }
    element('changelog').append(title, list);
  }
  const status = element('update-status');
  const button = element<HTMLButtonElement>('check-update');
  const install = element<HTMLButtonElement>('install-update');
  const progress = element<HTMLProgressElement>('update-progress');
  const badge = element('update-badge');
  let update: Update | null = null;
  let busy = false;
  button.disabled = !isTauri();
  if (!isTauri()) { status.textContent = 'Les mises à jour sont disponibles dans l’application Windows.'; return; }

  // Background checks stay silent: no network error, no "à jour" message. Installing always needs a click.
  const search = async (silent: boolean) => {
    if (busy) return;
    busy = true; button.disabled = true;
    if (!silent) { install.hidden = true; status.textContent = 'Recherche d’une mise à jour…'; }
    try {
      const found = await check({ timeout: 15_000 });
      if (found || !silent) {
        await update?.close().catch(() => {});
        update = found;
        status.textContent = found ? `Version ${found.version} disponible. L’installation fermera puis relancera DropMeme.` : 'Votre application est à jour.';
        install.hidden = badge.hidden = !found;
        if (found) await invoke('announce_update', { version: found.version }).catch(() => {});
      }
    } catch { if (!silent) status.textContent = 'Aucune mise à jour accessible. Réessayez après la publication de la prochaine version.'; }
    finally { busy = false; button.disabled = false; }
  };
  button.onclick = () => search(false);
  install.onclick = async () => {
    if (!update || busy) return;
    busy = true; install.disabled = true; button.disabled = true; progress.hidden = false;
    let received = 0; let total = 0;
    try {
      await update.downloadAndInstall(event => {
        if (event.event === 'Started') { total = event.data.contentLength ?? 0; received = 0; progress.removeAttribute('value'); }
        else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          if (total) progress.value = Math.min(100, received / total * 100);
          status.textContent = `Téléchargement : ${(received / 1024 / 1024).toFixed(1)} Mo${total ? ` / ${(total / 1024 / 1024).toFixed(1)} Mo` : ''}`;
        } else status.textContent = 'Téléchargement terminé. Vérification de la signature et installation…';
      });
      status.textContent = 'Installation terminée. Relancez DropMeme si nécessaire.';
    } catch { status.textContent = 'Mise à jour interrompue ou signature invalide. L’application actuelle reste disponible.'; }
    finally { busy = false; install.disabled = false; button.disabled = false; progress.hidden = true; }
  };
  // The tray entry is the user's explicit request to install.
  void listen('tray-update', () => { element('release-heading').scrollIntoView(); install.click(); }, { target: 'main' });
  void search(true);
  setInterval(() => void search(true), 6 * 60 * 60_000);
}
