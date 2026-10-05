import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { appVersion } from '@dropmeme/shared';

const animatedGif = readFileSync(new URL('../packages/desktop/public/preview.gif', import.meta.url));

test('0.1 preferences retain layout and duration while new consent and concurrency start disabled', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('dropmeme-preferences', JSON.stringify({ settings: { durationSeconds: 23, position: 'custom', monitor: 'primary', customX: 0.2, customY: 0.3, width: 600, height: 400 }, server: '' })));
  await page.reload();
  await expect(page.getByLabel('Durée des GIF')).toHaveValue('23');
  await expect(page.getByLabel('Durée des vidéos')).toHaveValue('23');
  await expect(page.getByLabel('Largeur')).toHaveValue('600');
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue('custom');
  await expect(page.getByLabel('Accepter les envois directs')).not.toBeChecked();
  await expect(page.getByLabel('Plusieurs GIF en même temps')).not.toBeChecked();
});

test('sober settings UI persists preferences and previews the local overlay', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DropMeme', exact: true })).toBeVisible();
  await expect(page.getByLabel('Lire le son')).not.toBeChecked();
  await page.getByLabel('Durée des GIF').fill('2');
  await page.getByLabel('Durée des GIF').blur();
  await expect(page.getByText('Réglages enregistrés.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Durée des GIF')).toHaveValue('2');
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

test('code pairing authenticates websocket, displays a media and unsubscribes', async ({ page }) => {
  const server = 'http://localhost:3000';
  await page.route(`${server}/v1/pair`, route => route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: JSON.stringify({ token: 'test-device-token-long-enough-123456789', deviceId: 'device', channelId: '123456789012345678', channelName: 'memes' }) }));
  await page.route(`${server}/v1/media/demo*`, route => route.fulfill({ contentType: 'image/gif', body: animatedGif }));
  await page.route(`${server}/v1/device`, route => route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' } }));
  await page.routeWebSocket('ws://localhost:3000/v1/events', socket => {
    socket.onMessage(message => {
      expect(JSON.parse(String(message))).toEqual({ type: 'authenticate', token: 'test-device-token-long-enough-123456789', protocol: 2, version: appVersion, profile: { name: 'Utilisateur', acceptDirect: false } });
      socket.send(JSON.stringify({ type: 'ready', channelId: '123456789012345678', channelName: 'memes', discordConnected: true }));
      setTimeout(() => socket.send(JSON.stringify({ type: 'media', id: 'demo', channelId: '123456789012345678', kind: 'image', url: `${server}/v1/media/demo?ticket=test`, name: 'animation.gif', author: 'Alice', createdAt: Date.now() })), 200);
    });
  });
  await page.goto('/');
  await page.getByLabel('Adresse du serveur').fill(server);
  await page.getByLabel('Code de connexion').fill('AAAAAAAA-BBBBBBBB');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
  await expect(page.getByText('En direct', { exact: true })).toBeVisible();
  await expect(page.getByText('memes', { exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe').getByRole('img', { name: 'animation.gif' })).toBeVisible();
  await expect(page.frameLocator('iframe').getByRole('img')).toHaveJSProperty('naturalWidth', 320);
  await page.getByRole('button', { name: 'Se désabonner' }).click();
  await expect(page.getByRole('button', { name: 'S’abonner au salon' })).toBeVisible();
  await expect(page.locator('iframe')).toBeHidden();
  const stored = await page.evaluate(() => localStorage.getItem('dropmeme-preferences'));
  expect(stored).not.toContain('test-device-token');
});

test('drags and resizes the placement tab, saves it and previews a GIF in that exact zone', async ({ page }) => {
  await page.goto('/');
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
  await page.reload();
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  const player = page.locator('iframe[title="Aperçu du média"]');
  await expect(page.frameLocator('iframe[title="Aperçu du média"]').getByRole('img')).toBeVisible();
  expect(await player.boundingBox()).toEqual(placed);
  await expect(player).toHaveCSS('pointer-events', 'none');
});

test('cancelling placement preserves settings and the preview reports a failed GIF load', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Placer sur l’écran' }).click();
  await page.frameLocator('iframe[title="Placer la zone"]').getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue('bottom-right');
  await page.route('**/preview.gif', route => route.abort());
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  await expect(page.locator('#message')).toHaveText('Image non lisible.');
  await expect(page.locator('iframe[title="Aperçu du média"]')).toBeHidden();
});

test('bundled GIF actually animates instead of rendering only its first frame', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  const image = page.frameLocator('iframe[title="Aperçu du média"]').getByRole('img');
  await expect(image).toBeVisible();
  // Canvas drawImage uses the default GIF frame; screenshots inspect the actual displayed animation.
  const snapshot = async () => (await image.screenshot()).toString('base64');
  const first = await snapshot();
  await expect.poll(snapshot, { timeout: 3000, intervals: [100, 150, 200] }).not.toBe(first);
});

test('simultaneous preview uses one surface, separate tiles and the GIF duration', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Plusieurs GIF en même temps')).not.toBeChecked();
  await page.getByLabel('Durée des GIF').fill('2'); await page.getByLabel('Durée des GIF').blur();
  await page.getByLabel('Plusieurs GIF en même temps').check();
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  const frame = page.frameLocator('iframe[title="Aperçu du média"]');
  await expect(page.locator('iframe[title="Aperçu du média"]')).toHaveCount(1);
  await expect(frame.getByRole('img')).toHaveCount(4);
  await expect(frame.getByText('De DropMeme', { exact: true })).toHaveCount(4);
  await page.getByLabel('Afficher l’expéditeur').uncheck();
  await expect(frame.getByText('De DropMeme', { exact: true }).first()).toBeHidden();
  await expect(page.locator('iframe[title="Aperçu du média"]')).toBeHidden({ timeout: 5000 });
});

test('custom GIF zones can be placed, persisted and previewed together', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Plusieurs GIF en même temps').check();
  await page.getByLabel('Placement des GIF').selectOption('zones');
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Ajouter une zone' }).click();
    await page.frameLocator('iframe[title="Placer la zone"]').getByRole('button', { name: 'Enregistrer la position' }).click();
    await expect(page.locator('#zones-list li')).toHaveCount(i + 1);
  }
  await page.reload(); await expect(page.locator('#zones-list li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  await expect(page.frameLocator('iframe[title="Aperçu du média"]').getByRole('img')).toHaveCount(2);
  await page.getByRole('button', { name: 'Passer', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Aperçu du média"]').getByRole('img')).toHaveCount(1);
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
  await page.goto('/'); await expect(page.getByLabel('Accepter les envois directs')).not.toBeChecked();
  await page.getByLabel('Adresse du serveur').fill(server); await page.getByLabel('Code de connexion').fill('AAAAAAAA-BBBBBBBB');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
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
  await page.goto('/');
  await page.getByLabel('Durée des GIF').fill('2'); await page.getByLabel('Durée des GIF').blur();
  await page.getByLabel('Durée des vidéos').fill('2'); await page.getByLabel('Durée des vidéos').blur();
  await page.getByLabel('Images et texte').fill('100'); await page.getByLabel('Images et texte').blur();
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
  await page.getByText('Nouveautés et historique', { exact: true }).click();
  await expect(page.locator('#changelog')).toContainText('0.2.0');
});
