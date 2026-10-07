import type { GifResult } from '@dropmeme/shared';

export type GridItem = Pick<GifResult, 'id' | 'previewUrl'>;

/** One tile per item, in the given order (Klipy attribution forbids reordering). Favorites will reuse it. */
export function renderGrid(list: HTMLElement, items: GridItem[], pick: (index: number, keepOpen: boolean) => void): void {
  list.replaceChildren(...items.map((item, i) => {
    const tile = document.createElement('li'); tile.id = `tile-${i}`; tile.role = 'option'; tile.ariaSelected = 'false'; tile.ariaLabel = `GIF ${i + 1}`;
    // Klipy previews are either WebP or MP4.
    const preview = /\.mp4$/i.test(new URL(item.previewUrl).pathname)
      ? Object.assign(document.createElement('video'), { muted: true, loop: true, autoplay: true, playsInline: true })
      : Object.assign(document.createElement('img'), { alt: '', loading: 'lazy', decoding: 'async' });
    preview.src = item.previewUrl;
    tile.append(preview); tile.onclick = event => pick(i, event.ctrlKey);
    return tile;
  }));
}

/**
 * Next selected tile for a navigation key, -1 for the search field, undefined to let the key act normally.
 * The field keeps the focus: ← → move its caret until a tile is selected.
 */
export function gridMove(index: number, key: { key: string; shiftKey?: boolean }, count: number, columns: number): number | undefined {
  if (!count) return undefined;
  const tab = key.key === 'Tab';
  if (index < 0) return key.key === 'ArrowDown' || (tab && !key.shiftKey) ? 0 : undefined;
  const row = (i: number) => Math.floor(i / columns);
  switch (key.key) {
    case 'ArrowRight': return Math.min(index + 1, count - 1);
    case 'ArrowLeft': return Math.max(index - 1, 0);
    // Below a partial last row, land on its last tile rather than staying put.
    case 'ArrowDown': return index + columns < count ? index + columns : row(index) < row(count - 1) ? count - 1 : index;
    case 'ArrowUp': return index - columns >= 0 ? index - columns : -1;
    case 'Tab': return key.shiftKey ? index - 1 : Math.min(index + 1, count - 1);
    default: return undefined;
  }
}
