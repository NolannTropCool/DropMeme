import assert from 'node:assert/strict';
import { WebSocket } from '/app/node_modules/ws/wrapper.mjs';
import { createApplication } from '/app/packages/server/dist/app.js';
import { extractDiscordMedia } from '/app/packages/server/dist/discord-media.js';
import { Embed } from '/app/node_modules/discord.js/src/index.js';

// Exercise the built production image without Discord credentials. The CDN and gateway are fixtures.
const channelId = '123456789012345678';
const config = {
  discordToken: 'unused', applicationId: channelId, guildId: channelId,
  allowedChannelIds: new Set([channelId]), publicUrl: 'http://localhost:3000',
  joinKey: 'fixture-invitation-at-least-24-chars', port: 0, host: '127.0.0.1',
  databasePath: '/data/smoke.sqlite', maxMediaBytes: 1024, maxClients: 10,
};
const application = await createApplication(config, {
  connected: () => true, channelName: async () => 'memes',
}, {
  logger: false,
  fetchMedia: async url => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': String(url).endsWith('.mp4') ? 'video/mp4' : 'image/png' } }),
});
let socket;
try {
  config.publicUrl = await application.app.listen({ host: '127.0.0.1', port: 0 });
  const pair = await fetch(`${config.publicUrl}/v1/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, joinKey: config.joinKey }),
  });
  assert.equal(pair.status, 201);
  const device = await pair.json();
  socket = new WebSocket(config.publicUrl.replace('http:', 'ws:') + '/v1/events');
  await new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: device.token })));
    socket.once('message', data => { assert.equal(JSON.parse(data).type, 'ready'); resolve(); });
  });
  const next = new Promise(resolve => socket.once('message', data => resolve(JSON.parse(data))));
  application.publish(channelId, 'Alice', { url: 'https://cdn.discordapp.com/attachments/1/2/test.png', name: 'test.png', contentType: 'image/png', size: 4 });
  const media = await next;
  const response = await fetch(media.url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
  // Use the production discord.js class: a plain {type: 'gifv'} object hid a real regression.
  const animated = new Embed({ type: 'gifv', video: { url: 'https://media.tenor.com/fixtureAAAAC/cat.mp4' } });
  const incoming = extractDiscordMedia({ id: 'gif-message', attachments: new Map(), embeds: [animated] })[0];
  assert.ok(incoming);
  const nextGif = new Promise(resolve => socket.once('message', data => resolve(JSON.parse(data))));
  assert.equal(application.publish(channelId, 'Alice', incoming), true);
  const gif = await nextGif;
  assert.equal(gif.kind, 'video'); assert.equal(gif.loop, true);
  const gifResponse = await fetch(gif.url);
  assert.equal(gifResponse.status, 200); assert.equal(gifResponse.headers.get('content-type'), 'video/mp4');
  const revoke = await fetch(`${config.publicUrl}/v1/device`, { method: 'DELETE', headers: { Authorization: `Bearer ${device.token}` } });
  assert.equal(revoke.status, 204);
  assert.equal((await fetch(media.url)).status, 404);
  console.log('Production image: SQLite, HTTP pairing, WebSocket, Discord GIF embeds, media proxy and revocation passed.');
} finally {
  socket?.terminate(); await application.app.close();
}
