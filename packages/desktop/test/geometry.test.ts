import { expect, test } from 'vitest';
import { defaultSettings, normalizeServerUrl } from '@dropmeme/shared';
import { overlayGeometry } from '../src/geometry.js';

test('handles physical DPI and secondary monitors with negative coordinates', () => {
  expect(overlayGeometry({ x: -1920, y: 0, width: 1920, height: 1080, scale: 1 }, defaultSettings)).toEqual({ x: -500, y: 740, width: 480, height: 320 });
  expect(overlayGeometry({ x: 0, y: 0, width: 3840, height: 2160, scale: 2 }, defaultSettings)).toEqual({ x: 2840, y: 1480, width: 960, height: 640 });
});
test('constrains overlay to available monitor dimensions', () => {
  const box = overlayGeometry({ x: 0, y: 0, width: 320, height: 240, scale: 1 }, { ...defaultSettings, position: 'center' });
  expect(box).toEqual({ x: 20, y: 20, width: 280, height: 200 });
});
test('requires HTTPS outside loopback and forbids credentials or hidden paths', () => {
  expect(normalizeServerUrl(' https://example.com/ ')).toBe('https://example.com');
  expect(normalizeServerUrl('http://localhost:3000')).toBe('http://localhost:3000');
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?token=secret', 'file:///tmp']) {
    expect(() => normalizeServerUrl(value)).toThrow();
  }
});
