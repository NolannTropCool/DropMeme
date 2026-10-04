import { test, expect } from '@playwright/test';

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
  await page.route(`${server}/v1/media/demo*`, route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64') }));
  await page.route(`${server}/v1/device`, route => route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' } }));
  await page.routeWebSocket('ws://localhost:3000/v1/events', socket => {
    socket.onMessage(message => {
      expect(JSON.parse(String(message))).toEqual({ type: 'authenticate', token: 'test-device-token-long-enough-123456789' });
      socket.send(JSON.stringify({ type: 'ready', channelId: '123456789012345678', channelName: 'memes', discordConnected: true }));
      setTimeout(() => socket.send(JSON.stringify({ type: 'media', id: 'demo', channelId: '123456789012345678', kind: 'image', url: `${server}/v1/media/demo?ticket=test`, name: 'photo.png', author: 'Alice', createdAt: Date.now() })), 200);
    });
  });
  await page.goto('/');
  await page.getByLabel('Adresse du serveur').fill(server);
  await page.getByLabel('Code de connexion').fill('AAAAAAAA-BBBBBBBB');
  await page.getByRole('button', { name: 'S’abonner au salon' }).click();
  await expect(page.getByText('En direct', { exact: true })).toBeVisible();
  await expect(page.getByText('memes', { exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe').getByRole('img', { name: 'photo.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Se désabonner' }).click();
  await expect(page.getByRole('button', { name: 'S’abonner au salon' })).toBeVisible();
  await expect(page.locator('iframe')).toBeHidden();
  const stored = await page.evaluate(() => localStorage.getItem('dropmeme-preferences'));
  expect(stored).not.toContain('test-device-token');
});
