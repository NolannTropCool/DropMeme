import assert from 'node:assert/strict';
import { WebSocket } from '/app/node_modules/ws/wrapper.mjs';
import { createApplication } from '/app/packages/server/dist/app.js';
import { extractDiscordMedia } from '/app/packages/server/dist/discord-media.js';
import { Embed } from '/app/node_modules/discord.js/src/index.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { convertMov } from '/app/packages/server/dist/convert.js';

// Real multi-frame MOV conversion with the production FFmpeg binary and read-only container.
const folder = await mkdtemp('/tmp/dropmeme-smoke-');
let movFixture;
try {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-t', '0.4', '-c:v', 'mpeg4', `${folder}/source.mov`]);
  movFixture = await readFile(`${folder}/source.mov`);
  const result = await convertMov(movFixture, 1024 * 1024);
  assert.equal(result.contentType, 'video/mp4');
  await writeFile(`${folder}/result.mp4`, result.bytes);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', `${folder}/result.mp4`], { encoding: 'utf8' }));
  assert.equal(probe.streams[0].codec_name, 'h264'); assert.equal(probe.streams[0].width, 64); assert.equal(Number(probe.streams[0].nb_frames), 4);
} finally { await rm(folder, { recursive: true, force: true }); }

// Exercise the built production image without Discord credentials. The CDN and gateway are fixtures.
const channelId = '123456789012345678';
const config = {
  discordToken: 'unused', applicationId: channelId, guildId: channelId,
  allowedChannelIds: new Set([channelId]), publicUrl: 'http://localhost:3000',
  joinKey: 'fixture-invitation-at-least-24-chars', port: 0, host: '127.0.0.1',
  databasePath: '/data/smoke.sqlite', maxMediaBytes: 1024 * 1024, maxClients: 10,
};
const application = await createApplication(config, {
  connected: () => true, channelName: async () => 'memes',
}, {
  logger: false,
  fetchMedia: async url => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': String(url).endsWith('.mp4') ? 'video/mp4' : 'image/png' } }),
});
let socket;
const nextMedia = () => new Promise(resolve => {
  const handler = data => { const event = JSON.parse(data); if (event.type === 'media') { socket.off('message', handler); resolve(event); } };
  socket.on('message', handler);
});
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
    socket.once('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: device.token, protocol: 2, version: '0.2.0', profile: { name: 'Alice', acceptDirect: false } })));
    socket.once('message', data => { assert.equal(JSON.parse(data).type, 'ready'); resolve(); });
  });
  const next = nextMedia();
  application.publish(channelId, 'Alice', { url: 'https://cdn.discordapp.com/attachments/1/2/test.png', name: 'test.png', contentType: 'image/png', size: 4 });
  const media = await next;
  const response = await fetch(media.url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
  // Use the production discord.js class: a plain {type: 'gifv'} object hid a real regression.
  const animated = new Embed({ type: 'gifv', video: { url: 'https://media.tenor.com/fixtureAAAAC/cat.mp4' } });
  const incoming = extractDiscordMedia({ id: 'gif-message', attachments: new Map(), embeds: [animated] })[0];
  assert.ok(incoming);
  const nextGif = nextMedia();
  assert.equal(application.publish(channelId, 'Alice', incoming), true);
  const gif = await nextGif;
  assert.equal(gif.kind, 'video'); assert.equal(gif.loop, true);
  const gifResponse = await fetch(gif.url);
  assert.equal(gifResponse.status, 200); assert.equal(gifResponse.headers.get('content-type'), 'video/mp4');
  const nextMov = nextMedia();
  const form = new FormData(); form.append('file', new Blob([movFixture], { type: 'video/quicktime' }), 'animation.mov');
  const uploaded = await fetch(`${config.publicUrl}/v2/send/file`, { method: 'POST', headers: { Authorization: `Bearer ${device.token}` }, body: form });
  assert.equal(uploaded.status, 201);
  const mov = await nextMov; assert.equal(mov.kind, 'video'); assert.equal(mov.name, 'animation.mp4'); assert.equal(mov.author, 'Alice');
  const movie = await fetch(mov.url); assert.equal(movie.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await movie.arrayBuffer()).subarray(4, 8).toString(), 'ftyp');
  const revoke = await fetch(`${config.publicUrl}/v1/device`, { method: 'DELETE', headers: { Authorization: `Bearer ${device.token}` } });
  assert.equal(revoke.status, 204);
  assert.equal((await fetch(media.url)).status, 404);
  console.log('Production image: real MOV/H.264 conversion, SQLite, HTTP pairing, WebSocket, Discord GIF embeds, media proxy and revocation passed.');
} finally {
  socket?.terminate(); await application.app.close();
}
