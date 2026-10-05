import { overlayGeometry, type DisplayRect, type ScreenRect } from './geometry.js';
import type { Settings } from '@dropmeme/shared';

const overlap = (a: DisplayRect, b: DisplayRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** Try several placements and keep the one overlapping existing GIFs the least. */
export function randomGeometry(screen: ScreenRect, settings: Settings, occupied: DisplayRect[], random: () => number = Math.random): DisplayRect {
  const base = overlayGeometry(screen, { ...settings, position: 'custom' });
  let best = base; let score = Infinity;
  for (let attempt = 0; attempt < 40; attempt++) {
    const box = { ...base, x: screen.x + Math.round(random() * (screen.width - base.width)), y: screen.y + Math.round(random() * (screen.height - base.height)) };
    const collision = occupied.reduce((sum, other) => sum + overlap(box, other), 0);
    if (collision < score) { best = box; score = collision; }
    if (!collision) break;
  }
  return best;
}
