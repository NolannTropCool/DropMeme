/** A Klipy result, or a favorite whose preview may be an object URL: `video` then says what it holds. */
export interface GridItem { previewUrl: string; video?: boolean; label?: string }

// Same formats as /v2/send/file, which sniffs the bytes anyway: HTML, SVG and the rest are refused.
export const accepted: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
export const acceptedTypes = [...new Set(Object.values(accepted))];
/** Before a 0.3 server announces its limit in ready. */
export const defaultMaxMediaBytes = 25 * 1024 * 1024;
export const formatSize = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} Ko` : `${(bytes / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;

/** French reason the server would refuse this file, or undefined. Windows may report no or a generic type: the extension decides then. */
export function fileError(file: Pick<File, 'name' | 'type' | 'size'>, maxBytes: number): string | undefined {
  if (!acceptedTypes.includes(file.type) && !accepted[file.name.split('.').at(-1)!.toLowerCase()]) return 'Format refusé. Utilisez une image, un GIF, WebP, MP4, WebM ou MOV.';
  if (!file.size) return 'Ce fichier est vide.';
  if (file.size > maxBytes) return `Fichier trop volumineux : ${formatSize(maxBytes)} maximum.`;
  return undefined;
}

/** Muted looping preview; videos autoplay like the GIFs they stand for. */
export function mediaElement(src: string, video: boolean): HTMLImageElement | HTMLVideoElement {
  const media = video
    ? Object.assign(document.createElement('video'), { muted: true, loop: true, autoplay: true, playsInline: true })
    : Object.assign(document.createElement('img'), { alt: '', loading: 'lazy', decoding: 'async' });
  media.src = src;
  return media;
}

/**
 * One tile per item, in the given order (Klipy attribution forbids reordering), with ids `${prefix}-${index}`.
 * A star button is added when `star` is given; it adds to the favorites without picking the tile.
 */
export function renderGrid(list: HTMLElement, items: GridItem[], pick: (index: number, keepOpen: boolean) => void, { prefix = 'tile', star }: { prefix?: string; star?: (index: number) => void } = {}): void {
  list.replaceChildren(...items.map((item, i) => {
    const tile = document.createElement('li'); tile.id = `${prefix}-${i}`; tile.role = 'option'; tile.ariaSelected = 'false'; tile.ariaLabel = item.label ?? `GIF ${i + 1}`;
    if (item.label) tile.title = item.label;
    // Klipy previews are either WebP or MP4.
    tile.append(mediaElement(item.previewUrl, item.video ?? /\.mp4$/i.test(new URL(item.previewUrl).pathname))); tile.onclick = event => pick(i, event.ctrlKey);
    if (star) {
      // Out of the tab order: Ctrl+D stars the selected tile from the search field.
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'star', tabIndex: -1, textContent: '☆', title: 'Ajouter aux favoris (Ctrl+D)' });
      button.ariaLabel = 'Ajouter aux favoris'; button.ariaPressed = 'false';
      button.onclick = event => { event.stopPropagation(); star(i); };
      tile.append(button);
    }
    return tile;
  }));
}

/**
 * Next selected tile for a navigation key, -1 for the search field, undefined to let the key act normally.
 * The field keeps the focus: ← → move its caret until a tile is selected.
 * Several counts are grids stacked in that order, each starting a new row; the index runs across them.
 */
export function gridMove(index: number, key: { key: string; shiftKey?: boolean }, count: number | readonly number[], columns: number): number | undefined {
  const sections = typeof count === 'number' ? [count] : count;
  const total = sections.reduce((sum, size) => sum + size, 0);
  if (!total) return undefined;
  const tab = key.key === 'Tab';
  if (index < 0) return key.key === 'ArrowDown' || (tab && !key.shiftKey) ? 0 : undefined;
  const rows: { first: number; length: number }[] = [];
  let first = 0;
  for (const size of sections) {
    for (let i = 0; i < size; i += columns) rows.push({ first: first + i, length: Math.min(columns, size - i) });
    first += size;
  }
  const row = rows.findIndex(item => index < item.first + item.length);
  // Same column in another row, or the last tile of a shorter (partial) row.
  const at = (target: number) => rows[target]!.first + Math.min(index - rows[row]!.first, rows[target]!.length - 1);
  switch (key.key) {
    case 'ArrowRight': return Math.min(index + 1, total - 1);
    case 'ArrowLeft': return Math.max(index - 1, 0);
    case 'ArrowDown': return row + 1 < rows.length ? at(row + 1) : index;
    case 'ArrowUp': return row > 0 ? at(row - 1) : -1;
    case 'Tab': return key.shiftKey ? index - 1 : Math.min(index + 1, total - 1);
    default: return undefined;
  }
}
