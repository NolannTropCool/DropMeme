import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const mode = process.argv[2];
const root = JSON.parse(await readFile('package.json', 'utf8'));
const [major, minor, patch] = root.version.split('.').map(Number);
if (!['minor', 'patch', '--check'].includes(mode)) throw new Error('Usage : npm run version:app -- minor|patch|--check');
const version = mode === 'minor' ? `${major}.${minor + 1}.0` : mode === 'patch' ? `${major}.${minor}.${patch + 1}` : root.version;
// Fail before the Windows build: release-manifest.mjs only accepts this exact tag.
if (mode === '--check' && process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error(`Tag de publication incohérent : utilisez v${version} (reçu ${process.env.GITHUB_REF_NAME}).`);
const paths = ['package.json', 'packages/shared/package.json', 'packages/server/package.json', 'packages/desktop/package.json', 'packages/desktop/src-tauri/tauri.conf.json'];
for (const path of paths) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (mode === '--check') {
    if (value.version !== version || (value.dependencies?.['@dropmeme/shared'] && value.dependencies['@dropmeme/shared'] !== version)) throw new Error(`Version incohérente : ${path}`);
  } else {
    value.version = version;
    if (value.dependencies?.['@dropmeme/shared']) value.dependencies['@dropmeme/shared'] = version;
    await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  }
}
const replacements = [
  ['packages/shared/src/index.ts', /export const appVersion = '[^']+';/, `export const appVersion = '${version}';`],
  ['packages/desktop/src-tauri/Cargo.toml', /^version = "[^"]+"/m, `version = "${version}"`],
  ['packages/desktop/src-tauri/Cargo.lock', /(name = "dropmeme"\n)version = "[^"]+"/, `$1version = "${version}"`],
];
for (const [path, pattern, replacement] of replacements) {
  const source = await readFile(path, 'utf8');
  const updated = source.replace(pattern, replacement);
  if (mode === '--check') { if (updated !== source) throw new Error(`Version incohérente : ${path}`); }
  else await writeFile(path, updated);
}
// Through a shell: Node refuses to spawn npm.cmd directly on Windows (EINVAL).
// npm run exports user config as npm_config_* variables, and npm 12 rejects allow-scripts there for project installs.
const { npm_config_allow_scripts: _allowScripts, ...npmEnvironment } = process.env;
if (mode !== '--check') execSync('npm install --package-lock-only --ignore-scripts', { stdio: 'inherit', env: npmEnvironment });
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
if (lock.version !== version || lock.packages[''].version !== version) throw new Error('package-lock.json incohérent.');
for (const workspace of ['shared', 'server', 'desktop']) if (lock.packages[`packages/${workspace}`].version !== version) throw new Error(`Lockfile du workspace ${workspace} incohérent.`);
if (mode === '--check') {
  const notes = await readFile('CHANGELOG.md', 'utf8');
  const embedded = await readFile('packages/desktop/src/changelog.ts', 'utf8');
  if (!notes.includes(`## ${version}\n`) || !embedded.includes(`version: '${version}'`)) throw new Error('Ajoutez cette version aux deux changelogs avant de publier.');
}
console.log(`DropMeme ${version}${mode === '--check' ? ' : versions cohérentes.' : ' : ajoutez les nouveautés au changelog avant de publier.'}`);
