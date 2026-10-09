import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
const tag = process.env.GITHUB_REF_NAME;
const repository = process.env.GITHUB_REPOSITORY;
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (!directory || tag !== `v${pkg.version}` || repository !== 'NolannTropCool/DropMeme') throw new Error('Tag, version ou dépôt de publication incohérent.');
const installers = (await readdir(directory)).filter(name => name.endsWith('-setup.exe'));
if (installers.length !== 1) throw new Error('Un unique installateur Windows x64 est requis.');
const installer = installers[0];
const signature = (await readFile(join(directory, `${installer}.sig`), 'utf8')).trim();
if (!signature || !/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error('Signature de mise à jour absente ou invalide.');
// The Tauri CLI only warns on a key mismatch, yet every installed client would reject the update.
// Minisign line 2 starts with the algorithm (2 bytes) then the key id (8 bytes).
const minisignLines = value => Buffer.from(value, 'base64').toString('utf8').split('\n');
const keyId = line => Buffer.from(line ?? '', 'base64').subarray(2, 10).toString('hex');
const [, signatureLine, trustedComment] = minisignLines(signature);
const { pubkey } = JSON.parse(await readFile('packages/desktop/src-tauri/tauri.conf.json', 'utf8')).plugins.updater;
if (keyId(signatureLine) !== keyId(minisignLines(pubkey)[1])) throw new Error('Installateur signé avec une autre clé que celle de tauri.conf.json : vérifiez le secret TAURI_SIGNING_PRIVATE_KEY.');
if (!trustedComment?.split('\t').includes(`version:${pkg.version}`)) throw new Error(`La signature ne porte pas la version ${pkg.version} exigée par requireSignedVersion.`);
const changelog = await readFile('CHANGELOG.md', 'utf8');
const notes = changelog.split(`## ${pkg.version}\n`)[1]?.split('\n## ')[0]?.trim();
if (!notes) throw new Error('Changelog de la version absent.');
await writeFile(join(directory, 'latest.json'), JSON.stringify({
  version: pkg.version, notes, pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature, url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(installer)}` } },
}, null, 2) + '\n');
