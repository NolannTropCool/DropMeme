import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { appVersion, defaultSettings } from '@dropmeme/shared';

const animatedGif = readFileSync(new URL('../packages/desktop/public/preview.gif', import.meta.url));
const open = (page: Page, section: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: section, exact: true }).click();

test('sidebar tabs show one section at a time and mark the current one', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Adresse du serveur')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tester l’affichage' })).toBeHidden();
  await open(page, 'Affichage');
  await expect(page.getByRole('button', { name: 'Tester l’affichage' })).toBeVisible();
  await expect(page.getByLabel('Adresse du serveur')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Affichage', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Accueil', exact: true })).not.toHaveAttribute('aria-current', 'page');
  await open(page, 'Envois'); await page.getByLabel('Votre pseudo dans l’application').fill('Nolann'); await page.getByLabel('Votre pseudo dans l’application').blur();
  await expect(page.locator('#greeting-name')).toHaveText('Nolann');
});

test('a release found at launch locks the desktop app until it installs, with retry after a failure', async ({ page }) => {
  // Minimal Tauri IPC double: the real updater plugin bindings run against it.
  await page.addInitScript(() => {
    const callbacks = new Map<number, (message: unknown) => void>(); let nextCallback = 1;
    const state = { installs: 0 };
    const responses: Record<string, unknown> = {
      'plugin:store|load': 1, 'plugin:store|get': [null, false], 'plugin:event|listen': 1, 'plugin:window|available_monitors': [], 'plugin:autostart|is_enabled': false,
      'plugin:updater|check': { rid: 2, currentVersion: '0.4.0', version: '0.9.0', date: null, body: '', rawJson: {} },
    };
    Object.assign(window, { isTauri: true, updateState: state, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: (callback: (message: unknown) => void) => { callbacks.set(nextCallback, callback); return nextCallback++; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: { onEvent?: { id: number } }) => {
        if (command !== 'plugin:updater|download_and_install') return responses[command] ?? null;
        const send = callbacks.get(args.onEvent!.id)!;
        send({ index: 0, message: { event: 'Started', data: { contentLength: 4 * 1024 * 1024 } } });
        send({ index: 1, message: { event: 'Progress', data: { chunkLength: 2 * 1024 * 1024 } } });
        if (++state.installs === 1) throw 'error sending request';
        send({ index: 2, message: { event: 'Finished' } });
        return null;
      },
    } });
  });
  await page.goto('/');
  const gate = page.getByRole('alertdialog', { name: 'Mise à jour obligatoire' });
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('La version 0.9.0 doit être installée');
  await expect(page.locator('.app')).toHaveAttribute('inert', '');
  await expect(gate).toContainText('Installation impossible (error sending request)');
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(gate).toContainText('Installation terminée');
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { updateState: { installs: number } }).updateState.installs)).toBe(2);
});

test('0.1 preferences retain layout and duration while new consent and concurrency start disabled', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('dropmeme-preferences', JSON.stringify({ settings: { durationSeconds: 23, position: 'custom', monitor: 'primary', customX: 0.2, customY: 0.3, width: 600, height: 400 }, server: '' })));
  await page.reload();
  await open(page, 'Médias');
  await expect(page.getByLabel('Durée des GIF')).toHaveValue('23');
  await expect(page.getByLabel('Durée des vidéos')).toHaveValue('23');
  await open(page, 'Affichage');
  await expect(page.getByLabel('Largeur')).toHaveValue('600');
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue('custom');
  await expect(page.getByLabel('Plusieurs GIF et textes en même temps')).not.toBeChecked();
  await open(page, 'Envois');
  await expect(page.getByLabel('Accepter les envois directs')).not.toBeChecked();
});

test('sober settings UI persists preferences and previews the local overlay', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DropMeme', exact: true })).toBeVisible();
  await open(page, 'Médias');
  await expect(page.getByLabel('Lire le son')).not.toBeChecked();
  await page.getByLabel('Durée des GIF').fill('2');
  await page.getByLabel('Durée des GIF').blur();
  await expect(page.getByText('Réglages enregistrés.', { exact: true })).toBeVisible();
  await page.reload();
  await open(page, 'Médias');
  await expect(page.getByLabel('Durée des GIF')).toHaveValue('2');
  await open(page, 'Affichage');
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  const frame = page.frameLocator('iframe[title="Aperçu du média"]');
  await expect(frame.getByRole('img', { name: 'Aperçu DropMeme.gif' })).toBeVisible();
  await expect(frame.getByRole('img')).toHaveJSProperty('naturalWidth', 320);
  await expect(page.locator('iframe')).toBeHidden({ timeout: 5000 });
});

test('channel-ID entry validates invitation key and remote HTTPS', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'ID du salon', exact: true }).click();
  await page.getByLabel('Adresse du serveur').fill('http://example.com');
  await page.getByLabel('ID du salon', { exact: true }).fill('123456789012345678');
  await page.getByLabel('Clé d’invitation').fill('a-long-enough-test-invitation-key');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
  await expect(page.locator('#message')).toContainText('HTTPS est obligatoire');
});

test('code pairing links the Discord account, authenticates websocket, displays a media and unsubscribes', async ({ page }) => {
  const server = 'http://localhost:3000'; const userId = '223456789012345678';
  await page.route(`${server}/v1/pair`, route => route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: JSON.stringify({ token: 'test-device-token-long-enough-123456789', deviceId: 'device', channelId: '123456789012345678', channelName: 'memes', discordUserId: userId, discordUserName: 'Nolann' }) }));
  await page.route(`${server}/v1/media/demo*`, route => route.fulfill({ contentType: 'image/gif', body: animatedGif }));
  await page.route(`${server}/v1/device`, route => route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' } }));
  await page.routeWebSocket('ws://localhost:3000/v1/events', socket => {
    socket.onMessage(message => {
      expect(JSON.parse(String(message))).toEqual({ type: 'authenticate', token: 'test-device-token-long-enough-123456789', protocol: 2, version: appVersion, profile: { name: 'Utilisateur', acceptDirect: false } });
      socket.send(JSON.stringify({ type: 'ready', channelId: '123456789012345678', channelName: 'memes', discordConnected: true, discordUserId: userId, discordUserName: 'Nolann' }));
      setTimeout(() => socket.send(JSON.stringify({ type: 'media', id: 'demo', channelId: '123456789012345678', kind: 'image', url: `${server}/v1/media/demo?ticket=test`, name: 'animation.gif', author: 'Alice', createdAt: Date.now() })), 200);
    });
  });
  await page.goto('/');
  await page.getByLabel('Adresse du serveur').fill(server);
  await page.getByLabel('Code de connexion').fill('AAAAAAAA-BBBBBBBB');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
  await expect(page.getByText('En direct', { exact: true })).toBeVisible();
  await expect(page.getByText('memes', { exact: true })).toBeVisible();
  await expect(page.locator('#discord-identity-status')).toHaveText('Nolann');
  await expect(page.getByRole('button', { name: 'Lier le compte' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Lier un autre compte' })).toBeVisible();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('dropmeme-preferences')))!).subscription).toMatchObject({ discordUserId: userId, discordUserName: 'Nolann' });
  await expect(page.frameLocator('iframe').getByRole('img', { name: 'animation.gif' })).toBeVisible();
  await expect(page.frameLocator('iframe').getByRole('img')).toHaveJSProperty('naturalWidth', 320);
  await page.getByRole('button', { name: 'Se désabonner' }).click();
  await expect(page.getByRole('button', { name: 'S’abonner au salon' })).toBeVisible();
  await expect(page.locator('iframe')).toBeHidden();
  const stored = await page.evaluate(() => localStorage.getItem('dropmeme-preferences'));
  expect(stored).not.toContain('test-device-token');
});

test('drags and resizes the placement tab, saves it and previews a GIF in that exact zone', async ({ page }) => {
  await page.goto('/'); await open(page, 'Affichage');
  await page.getByRole('button', { name: 'Placer sur l’écran' }).click();
  const editor = page.frameLocator('iframe[title="Placer la zone"]');
  const iframe = page.locator('iframe[title="Placer la zone"]');
  const before = (await iframe.boundingBox())!;
  const tab = (await editor.getByRole('button', { name: 'Déplacer la zone' }).boundingBox())!;
  await page.mouse.move(tab.x + 40, tab.y + 15); await page.mouse.down();
  await page.mouse.move(tab.x - 160, tab.y - 85, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await iframe.boundingBox())!.x).toBeCloseTo(before.x - 200, 0);
  const handle = (await editor.getByRole('button', { name: 'Redimensionner la zone' }).boundingBox())!;
  await page.mouse.move(handle.x + 10, handle.y + 10); await page.mouse.down();
  await page.mouse.move(handle.x + 110, handle.y + 60, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await iframe.boundingBox())!.width).toBeCloseTo(before.width + 100, 0);
  const placed = (await iframe.boundingBox())!;
  await editor.getByRole('button', { name: 'Enregistrer la position' }).click();
  await expect(iframe).toHaveCount(0);
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue('custom');
  await expect(page.locator('#saved')).toContainText('Disposition enregistrée');
  await page.reload(); await open(page, 'Affichage');
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  const player = page.locator('iframe[title="Aperçu du média"]');
  await expect(page.frameLocator('iframe[title="Aperçu du média"]').getByRole('img')).toBeVisible();
  expect(await player.boundingBox()).toEqual(placed);
  await expect(player).toHaveCSS('pointer-events', 'none');
});

test('cancelling placement preserves settings and the preview reports a failed GIF load', async ({ page }) => {
  await page.goto('/'); await open(page, 'Affichage');
  await page.getByRole('button', { name: 'Placer sur l’écran' }).click();
  await page.frameLocator('iframe[title="Placer la zone"]').getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue('bottom-right');
  await page.route('**/preview.gif', route => route.abort());
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  await expect(page.locator('#message')).toHaveText('Image non lisible.');
  await expect(page.locator('iframe[title="Aperçu du média"]')).toBeHidden();
});

test('bundled GIF actually animates instead of rendering only its first frame', async ({ page }) => {
  await page.goto('/'); await open(page, 'Affichage');
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  const image = page.frameLocator('iframe[title="Aperçu du média"]').getByRole('img');
  await expect(image).toBeVisible();
  // Canvas drawImage uses the default GIF frame; screenshots inspect the actual displayed animation.
  const snapshot = async () => (await image.screenshot()).toString('base64');
  const first = await snapshot();
  await expect.poll(snapshot, { timeout: 3000, intervals: [100, 150, 200] }).not.toBe(first);
});

test('simultaneous preview uses one surface, separate tiles and the GIF duration', async ({ page }) => {
  await page.goto('/'); await open(page, 'Affichage');
  await expect(page.getByLabel('Plusieurs GIF et textes en même temps')).not.toBeChecked();
  await open(page, 'Médias');
  await page.getByLabel('Durée des GIF').fill('2'); await page.getByLabel('Durée des GIF').blur();
  await open(page, 'Affichage');
  await page.getByLabel('Plusieurs GIF et textes en même temps').check();
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  const frame = page.frameLocator('iframe[title="Aperçu du média"]');
  await expect(page.locator('iframe[title="Aperçu du média"]')).toHaveCount(1);
  await expect(frame.getByRole('img')).toHaveCount(4);
  await expect(frame.getByText('De DropMeme', { exact: true })).toHaveCount(4);
  await open(page, 'Médias');
  await page.getByLabel('Afficher l’expéditeur').uncheck();
  await expect(frame.getByText('De DropMeme', { exact: true }).first()).toBeHidden();
  await expect(page.locator('iframe[title="Aperçu du média"]')).toBeHidden({ timeout: 5000 });
});

test('custom GIF zones can be placed, persisted and previewed together', async ({ page }) => {
  await page.goto('/'); await open(page, 'Affichage'); await page.getByLabel('Plusieurs GIF et textes en même temps').check();
  await page.getByLabel('Placement des GIF et textes').selectOption('zones');
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Ajouter une zone' }).click();
    await page.frameLocator('iframe[title="Placer la zone"]').getByRole('button', { name: 'Enregistrer la position' }).click();
    await expect(page.locator('#zones-list li')).toHaveCount(i + 1);
  }
  await page.reload(); await open(page, 'Affichage'); await expect(page.locator('#zones-list li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  await expect(page.frameLocator('iframe[title="Aperçu du média"]').getByRole('img')).toHaveCount(2);
  await page.getByRole('button', { name: 'Passer', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Aperçu du média"]').getByRole('img')).toHaveCount(1);
});

test('editing the first and middle zones preserves their identity, order and saved placement', async ({ page }) => {
  await page.goto('/');
  const zones = [0, 1, 2].map(i => ({ id: `stable-${i}`, monitor: 'primary', position: 'custom', x: i * 0.2, y: i * 0.1, width: 240 + i * 20, height: 160 + i * 20 }));
  await page.evaluate(settings => localStorage.setItem('dropmeme-preferences', JSON.stringify({ settings, server: '' })), { ...defaultSettings, multiDisplay: true, multiPlacement: 'zones', zones });
  await page.reload(); await open(page, 'Affichage');
  for (const index of [0, 1, 0]) {
    await page.locator('#zones-list li').nth(index).getByRole('button', { name: 'Placer', exact: true }).click();
    const editor = page.frameLocator('iframe[title="Placer la zone"]');
    const tab = (await editor.getByRole('button', { name: 'Déplacer la zone' }).boundingBox())!;
    await page.mouse.move(tab.x + 30, tab.y + 15); await page.mouse.down();
    await page.mouse.move(tab.x + 70, tab.y + 35, { steps: 5 }); await page.mouse.up();
    await editor.getByRole('button', { name: 'Enregistrer la position' }).click();
    await expect(page.locator('#saved')).toContainText('Disposition enregistrée');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('dropmeme-preferences')!).settings.zones);
    expect(stored.map((zone: { id: string }) => zone.id)).toEqual(zones.map(zone => zone.id));
    expect(stored[index].x).not.toBe(zones[index]!.x);
    expect(stored[2]).toEqual(zones[2]);
    await page.reload(); await open(page, 'Affichage');
    await expect(page.locator('#zones-list li').nth(index)).toContainText(`Zone ${index + 1} · ${zones[index]!.width} × ${zones[index]!.height}`);
  }
  const before = await page.evaluate(() => localStorage.getItem('dropmeme-preferences'));
  await page.locator('#zones-list li').first().getByRole('button', { name: 'Placer', exact: true }).click();
  await page.frameLocator('iframe[title="Placer la zone"]').getByRole('button', { name: 'Annuler', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('dropmeme-preferences'))).toBe(before);
});

test('texts and GIF share the screen, captions move together, ordinary videos remain exclusive', async ({ page }) => {
  const server = 'http://localhost:3000'; const channelId = '123456789012345678';
  await page.route(`${server}/v1/pair`, route => route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: JSON.stringify({ token: 'test-device-token-long-enough-123456789', deviceId: 'device', channelId, channelName: 'memes' }) }));
  await page.route(`${server}/v1/media/gif*`, route => route.fulfill({ contentType: 'image/gif', body: animatedGif }));
  await page.route(`${server}/v1/media/video*`, route => route.fulfill({ contentType: 'video/mp4', body: readFileSync(new URL('./fixtures/video.mp4', import.meta.url)) }));
  await page.routeWebSocket('ws://localhost:3000/v1/events', socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'authenticate') return;
      socket.send(JSON.stringify({ type: 'ready', channelId, channelName: 'memes', discordConnected: true, protocol: 2, version: appVersion }));
      const common = { type: 'media', channelId, author: 'Alice', createdAt: Date.now() };
      const events = [
        { id: 'gif', kind: 'image', animation: true, name: 'cat.gif', caption: '<img src=x> Avec le GIF' },
        { id: 'text1', kind: 'text', name: 'Texte', text: 'Premier message' },
        { id: 'text2', kind: 'text', name: 'Texte', text: 'Deuxième message' },
        { id: 'video1', kind: 'video', name: 'video1.mp4', caption: 'Avec la vidéo' },
        { id: 'video2', kind: 'video', name: 'video2.mp4' },
      ];
      for (const media of events) socket.send(JSON.stringify({ ...common, ...media, url: `${server}/v1/media/${media.id}` }));
    });
  });
  await page.goto('/');
  await open(page, 'Affichage'); await page.getByLabel('Plusieurs GIF et textes en même temps').check();
  await open(page, 'Médias');
  for (const label of ['Durée des GIF', 'Images et texte', 'Durée des vidéos']) { await page.getByLabel(label).fill('100'); await page.getByLabel(label).blur(); }
  await open(page, 'Accueil');
  await page.getByLabel('Adresse du serveur').fill(server); await page.getByLabel('Code de connexion').fill('AAAAAAAA-BBBBBBBB');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
  const frame = page.frameLocator('iframe[title="Aperçu du média"]');
  await expect(frame.getByText('Premier message', { exact: true })).toBeVisible();
  await expect(frame.getByText('Deuxième message', { exact: true })).toBeVisible();
  await expect(frame.getByRole('img')).toHaveCount(1); await expect(frame.locator('video')).toHaveCount(0);
  const caption = frame.getByText('<img src=x> Avec le GIF', { exact: true }); await expect(caption).toBeVisible();
  expect((await caption.boundingBox())!.y).toBeGreaterThan((await frame.getByRole('img').boundingBox())!.y);
  await open(page, 'Médias');
  await page.getByLabel('Texte accompagnant le média').selectOption('above');
  await expect.poll(async () => (await caption.boundingBox())!.y < (await frame.getByRole('img').boundingBox())!.y).toBe(true);
  await page.locator('#texts').uncheck(); await expect(caption).toBeHidden();
  await page.locator('#texts').check(); await expect(caption).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Passer', exact: true }).click();
  await expect(frame.locator('video')).toHaveCount(1); await expect(frame.locator('.text-tile')).toHaveCount(0); await expect(frame.getByRole('img')).toHaveCount(0);
  await expect(frame.locator('video')).toHaveAttribute('src', `${server}/v1/media/video1`);
  await expect(frame.getByText('Avec la vidéo', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Passer', exact: true }).click();
  await expect(frame.locator('video')).toHaveAttribute('src', `${server}/v1/media/video2`);
  await expect(frame.getByText('Avec la vidéo', { exact: true })).toHaveCount(0);
});

test('an existing subscription links its Discord account and sends one file with its caption', async ({ page }) => {
  const server = 'http://localhost:3000'; const channelId = '123456789012345678'; const userId = '223456789012345678';
  const headers = { 'Access-Control-Allow-Origin': 'http://localhost:1420' };
  await page.route(`${server}/v1/pair`, route => route.fulfill({ status: 201, contentType: 'application/json', headers, body: JSON.stringify({ token: 'test-device-token-long-enough-123456789', deviceId: 'device', channelId, channelName: 'memes' }) }));
  const links: unknown[] = []; const uploads: string[] = []; let textPosts = 0;
  await page.route(`${server}/v2/device/link`, route => { links.push(route.request().postDataJSON()); return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ discordUserId: userId, discordUserName: 'Nolann' }) }); });
  await page.route(`${server}/v2/send/file`, route => { uploads.push(route.request().postDataBuffer()!.toString()); return route.fulfill({ status: 201, contentType: 'application/json', headers, body: '{"id":"file"}' }); });
  await page.route(`${server}/v2/send/text`, route => { textPosts++; return route.fulfill({ status: 201, contentType: 'application/json', headers, body: '{"id":"text"}' }); });
  await page.routeWebSocket('ws://localhost:3000/v1/events', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type !== 'authenticate') return;
    socket.send(JSON.stringify({ type: 'ready', channelId, channelName: 'memes', discordConnected: true, protocol: 2, version: appVersion }));
  }));
  await page.goto('/'); await page.getByLabel('Adresse du serveur').fill(server); await page.getByLabel('Code de connexion').fill('AAAAAAAA-BBBBBBBB');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
  await expect(page.getByRole('button', { name: 'Lier le compte' })).toBeEnabled();
  await page.getByLabel('Lier votre compte Discord').fill('CCCCCCCC-DDDDDDDD'); await page.getByRole('button', { name: 'Lier le compte' }).click();
  await expect(page.locator('#discord-identity-status')).toHaveText('Nolann');
  await expect(page.getByRole('button', { name: 'Lier le compte' })).toBeHidden();
  expect(links).toEqual([{ code: 'CCCCCCCC-DDDDDDDD' }]);
  const stored = await page.evaluate(() => localStorage.getItem('dropmeme-preferences')!);
  expect(JSON.parse(stored).subscription).toMatchObject({ deviceId: 'device', discordUserId: userId, discordUserName: 'Nolann' });
  expect(stored).not.toContain('test-device-token'); expect(stored).not.toContain('CCCCCCCC-DDDDDDDD');
  await open(page, 'Envois');
  await page.locator('#send-text').fill('Un GIF et son message');
  await page.locator('#send-file').setInputFiles({ name: 'cat.gif', mimeType: 'image/gif', buffer: animatedGif });
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(page.locator('#send-status')).toContainText('1 envoi(s) transmis');
  expect(uploads).toHaveLength(1); expect(uploads[0]).toContain('name="caption"\r\n\r\nUn GIF et son message');
  expect(uploads[0]).toContain('filename="cat.gif"'); expect(textPosts).toBe(0);
  await expect(page.locator('#send-text')).toHaveValue('');
});

test('presence, targeted sending and consent withdrawal never silently broadcast', async ({ page }) => {
  const server = 'http://localhost:3000'; const peerId = '00000000-0000-4000-8000-000000000002';
  await page.route(`${server}/v1/pair`, route => route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: JSON.stringify({ token: 'test-device-token-long-enough-123456789', deviceId: 'device', channelId: '123456789012345678', channelName: 'memes' }) }));
  const sent: unknown[] = [];
  await page.route(`${server}/v2/send/text`, route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: '{"id":"text"}' });
  });
  let presence!: (consent: boolean) => void;
  await page.routeWebSocket('ws://localhost:3000/v1/events', socket => {
    presence = consent => socket.send(JSON.stringify({ type: 'presence', peers: [{ id: peerId, name: 'Bob', acceptDirect: consent, version: '0.2.0' }] }));
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'authenticate') return;
      socket.send(JSON.stringify({ type: 'ready', channelId: '123456789012345678', channelName: 'memes', discordConnected: true, protocol: 2, version: '0.2.0' }));
      presence(true);
      socket.send(JSON.stringify({ type: 'media', id: 'safe-text', channelId: '123456789012345678', kind: 'text', text: '<img src=x onerror=alert(1)>', url: `${server}/v1/media/safe-text`, name: 'Message', author: 'Bob', createdAt: Date.now() }));
    });
  });
  await page.goto('/'); await open(page, 'Envois'); await expect(page.getByLabel('Accepter les envois directs')).not.toBeChecked();
  await open(page, 'Accueil');
  await page.getByLabel('Adresse du serveur').fill(server); await page.getByLabel('Code de connexion').fill('AAAAAAAA-BBBBBBBB');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
  await expect(page.getByRole('button', { name: 'Lier le compte' })).toBeDisabled();
  await open(page, 'Envois');
  await expect(page.locator('#peers-list')).toContainText('Bob');
  const frame = page.frameLocator('iframe[title="Aperçu du média"]');
  await expect(frame.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(frame.getByRole('img')).toHaveCount(0);
  await page.getByLabel('Destinataire').selectOption(peerId);
  await page.locator('#send-text').fill('Bonjour Bob'); await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(page.locator('#send-status')).toContainText('au destinataire');
  expect(sent).toEqual([{ text: 'Bonjour Bob', recipientId: peerId }]);
  presence(false);
  await expect(page.getByRole('button', { name: 'Envoyer', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Destinataire')).toHaveValue(peerId);
  await page.getByLabel('Destinataire').selectOption('');
  await expect(page.getByRole('button', { name: 'Envoyer', exact: true })).toBeEnabled();
});

test('animated WebP keeps moving and a video follows its own duration', async ({ page }) => {
  const server = 'http://localhost:3000';
  await page.route(`${server}/v1/pair`, route => route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: JSON.stringify({ token: 'test-device-token-long-enough-123456789', deviceId: 'device', channelId: '123456789012345678', channelName: 'memes' }) }));
  await page.route(`${server}/v1/media/webp*`, route => route.fulfill({ contentType: 'image/webp', body: readFileSync(new URL('./fixtures/animation.webp', import.meta.url)) }));
  await page.route(`${server}/v1/media/video*`, route => route.fulfill({ contentType: 'video/mp4', body: readFileSync(new URL('./fixtures/video.mp4', import.meta.url)) }));
  await page.routeWebSocket('ws://localhost:3000/v1/events', socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'authenticate') return;
      socket.send(JSON.stringify({ type: 'ready', channelId: '123456789012345678', channelName: 'memes', discordConnected: true, protocol: 2 }));
      const common = { type: 'media', channelId: '123456789012345678', author: 'Alice', createdAt: Date.now() };
      socket.send(JSON.stringify({ ...common, id: 'webp', kind: 'image', animation: true, url: `${server}/v1/media/webp`, name: 'animation.webp' }));
      socket.send(JSON.stringify({ ...common, id: 'video', kind: 'video', url: `${server}/v1/media/video`, name: 'video.mp4' }));
    });
  });
  await page.goto('/'); await open(page, 'Médias');
  await page.getByLabel('Durée des GIF').fill('2'); await page.getByLabel('Durée des GIF').blur();
  await page.getByLabel('Durée des vidéos').fill('2'); await page.getByLabel('Durée des vidéos').blur();
  await page.getByLabel('Images et texte').fill('100'); await page.getByLabel('Images et texte').blur();
  await open(page, 'Accueil');
  await page.getByLabel('Adresse du serveur').fill(server); await page.getByLabel('Code de connexion').fill('AAAAAAAA-BBBBBBBB');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
  const frame = page.frameLocator('iframe[title="Aperçu du média"]'); const image = frame.getByRole('img');
  await expect(image).toBeVisible();
  const first = (await image.screenshot()).toString('base64');
  await expect.poll(async () => (await image.screenshot()).toString('base64'), { timeout: 1200, intervals: [100, 150] }).not.toBe(first);
  const video = frame.locator('video'); await expect(video).toBeVisible({ timeout: 5000 });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await expect(page.locator('iframe[title="Aperçu du média"]')).toBeHidden({ timeout: 4000 });
  await expect(page.locator('#queue-status')).toHaveText('Aucun média en attente');
  await open(page, 'Application');
  await page.getByText('Nouveautés et historique', { exact: true }).click();
  await expect(page.locator('#changelog')).toContainText('0.2.0');
});
