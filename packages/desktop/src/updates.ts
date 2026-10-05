import { isTauri } from '@tauri-apps/api/core';
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
  let update: Update | null = null;
  button.disabled = !isTauri();
  if (!isTauri()) status.textContent = 'Les mises à jour sont disponibles dans l’application Windows.';
  button.onclick = async () => {
    button.disabled = true; install.hidden = true; status.textContent = 'Recherche d’une mise à jour…';
    try {
      const previous = update; update = null;
      await previous?.close().catch(() => {});
      update = await check({ timeout: 15_000 });
      status.textContent = update ? `Version ${update.version} disponible. L’installation fermera puis relancera DropMeme.` : 'Votre application est à jour.';
      install.hidden = !update;
    } catch { status.textContent = 'Aucune mise à jour accessible. Réessayez après la publication de la prochaine version.'; }
    finally { button.disabled = false; }
  };
  install.onclick = async () => {
    if (!update) return;
    install.disabled = true; button.disabled = true; progress.hidden = false;
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
    finally { install.disabled = false; button.disabled = false; progress.hidden = true; }
  };
}
