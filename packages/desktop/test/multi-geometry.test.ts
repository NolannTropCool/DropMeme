import { expect, test } from 'vitest';
import { defaultSettings } from '@dropmeme/shared';
import { randomGeometry } from '../src/multi-geometry.js';

test('random GIFs fit ultrawide and scaled monitors with a negative origin', () => {
  for (const screen of [{ x: 0, y: 0, width: 5120, height: 1440, scale: 1 }, { x: -2560, y: -1440, width: 2560, height: 1440, scale: 2 }]) {
    const box = randomGeometry(screen, { ...defaultSettings, width: 8192, height: 4320 }, [], () => 0.7);
    expect(box.x).toBeGreaterThanOrEqual(screen.x); expect(box.y).toBeGreaterThanOrEqual(screen.y);
    expect(box.x + box.width).toBeLessThanOrEqual(screen.x + screen.width);
    expect(box.y + box.height).toBeLessThanOrEqual(screen.y + screen.height);
  }
});
test('placement retries occupied areas and chooses a free position', () => {
  const screen = { x: 0, y: 0, width: 2560, height: 1440, scale: 1 };
  let sample = 0;
  const box = randomGeometry(screen, defaultSettings, [{ x: 0, y: 0, width: 480, height: 320 }], () => sample++ < 2 ? 0 : 1);
  expect(box).toMatchObject({ x: 2080, y: 1120 });
});
