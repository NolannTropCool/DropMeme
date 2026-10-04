import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const animatedGif = readFileSync(new URL('../packages/desktop/public/preview.gif', import.meta.url));

test('sober settings UI persists preferences and previews the local overlay', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DropMeme', exact: true })).toBeVisible();
  await expect(page.getByLabel('Lire le son')).not.toBeChecked();
  await page.getByLabel('Durée maximale').fill('2');
  await page.getByLabel('Durée maximale').blur();
  await expect(page.getByText('Réglages enregistrés.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Durée maximale')).toHaveValue('2');
  await page.getByRole('button', { name: 'Tester l’affichage' }).click();
  const frame = page.frameLocator('iframe[title="Aperçu du média"]');
  await expect(frame.getByRole('img', { name: 'Aperçu DropMeme' })).toBeVisible();
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
      expect(JSON.parse(String(message))).toEqual({ type: 'authenticate', token: 'test-device-token-long-enough-123456789' });
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
