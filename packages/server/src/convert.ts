import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
let conversions = 0;

/** Untrusted uploads are recognized by their bytes, never just by their extension or MIME header. */
export function sniffContentType(bytes: Buffer, name: string): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString() === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return brand === 'qt  ' || /\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4';
  }
  if (/\.mov$/i.test(name) && ['moov', 'mdat', 'wide'].includes(bytes.subarray(4, 8).toString())) return 'video/quicktime';
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm';
  return undefined;
}

export async function convertMov(bytes: Buffer, maxBytes: number): Promise<{ bytes: Buffer; contentType: string }> {
  if (conversions >= 2) throw new Error('Deux conversions sont déjà en cours. Réessayez dans un instant.');
  conversions++;
  let folder: string | undefined;
  try {
    folder = await mkdtemp(join(tmpdir(), 'dropmeme-mov-'));
    const input = join(folder, 'input.mov'); const output = join(folder, 'output.mp4');
    await writeFile(input, bytes, { mode: 0o600 });
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-enable_drefs', '0', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '2',
      '-c:a', 'aac', '-b:a', '128k', '-t', '120', '-movflags', '+faststart', '-fs', String(maxBytes), '-y', output],
    { timeout: 45_000, maxBuffer: 64 * 1024 });
    const converted = await readFile(output);
    if (!converted.length || converted.length >= maxBytes) throw new Error('Conversion trop volumineuse.');
    return { bytes: converted, contentType: 'video/mp4' };
  } finally {
    conversions--; if (folder) await rm(folder, { recursive: true, force: true });
  }
}
