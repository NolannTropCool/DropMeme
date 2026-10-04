import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regenerate the small, entirely local animation used to test real GIF decoding.
// ImageMagick is needed only for regeneration, not for builds or at runtime.
const frames = Array.from({ length: 6 }, (_, index) => [
  '(', '-size', '320x180', 'xc:#1b211e', '-fill', '#b2d9ba',
  '-draw', `roundrectangle ${20 + index * 38},60 ${58 + index * 38},98 6,6`,
  '-font', 'DejaVu-Sans', '-pointsize', '15', '-gravity', 'South', '-annotate', '+0+20', 'DropMeme · GIF', ')',
]).flat();
const target = fileURLToPath(new URL('../packages/desktop/public/preview.gif', import.meta.url));
const result = spawnSync('convert', ['-delay', '18', ...frames, '-loop', '0', target], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
