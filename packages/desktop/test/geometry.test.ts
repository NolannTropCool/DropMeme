import { expect, test } from 'vitest';
import { defaultSettings, normalizeServerUrl, settingsSchema } from '@dropmeme/shared';
import { overlayGeometry, placementSettings, screenForBox, settingsForMonitor } from '../src/geometry.js';

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

test.each([5120, 2560])('custom position roundtrips on a %i×1440 monitor', width => {
  const screen = { x: 0, y: 0, width, height: 1440, scale: 1 };
  const box = { x: Math.round((width - 640) * 0.3), y: 460, width: 640, height: 360 };
  const saved = placementSettings(screen, box, defaultSettings, 'display');
  expect(settingsSchema.safeParse(saved).success).toBe(true);
  expect(overlayGeometry(screen, saved)).toEqual(box);
});
test('custom layout survives resolution and DPI changes and saves distinct layouts per monitor', () => {
  const wide = { x: -5120, y: 0, width: 5120, height: 1440, scale: 1 };
  const normal = { x: 0, y: 0, width: 2560, height: 1440, scale: 1.5 };
  const first = placementSettings(wide, { x: -2880, y: 540, width: 640, height: 360 }, defaultSettings, 'wide');
  const second = placementSettings(normal, { x: 160, y: 200, width: 720, height: 480 }, first, 'normal');
  expect(overlayGeometry(wide, settingsForMonitor(second, 'wide'))).toEqual({ x: -2880, y: 540, width: 640, height: 360 });
  expect(overlayGeometry(normal, settingsForMonitor(second, 'normal'))).toEqual({ x: 160, y: 200, width: 720, height: 480 });
  expect(overlayGeometry({ ...wide, x: 0, width: 2560 }, first)).toEqual({ x: 960, y: 540, width: 640, height: 360 });
});
test('clamps oversized or off-screen dragged frames and selects their actual monitor', () => {
  const screens = [{ x: -5120, y: 0, width: 5120, height: 1440, scale: 1 }, { x: 0, y: 0, width: 2560, height: 1440, scale: 1 }];
  expect(screenForBox(screens, { x: -100, y: 200, width: 640, height: 360 })).toBe(1);
  const saved = placementSettings(screens[1]!, { x: -100, y: 1500, width: 9000, height: 6000 }, defaultSettings, 'normal');
  expect(overlayGeometry(screens[1]!, saved)).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
});
test('existing preferences migrate custom defaults without changing previous placement', () => {
  const settings = settingsSchema.parse({ position: 'center', width: 600 });
  expect(settings.layouts).toEqual({});
  expect(settings.customX).toBe(1);
  expect(settings.width).toBe(600);
});
test('switching monitors restores a saved preset as well as a custom layout', () => {
  const settings = settingsSchema.parse({ position: 'custom', layouts: { normal: { position: 'center', x: 0.5, y: 0.5, width: 320, height: 240 } } });
  expect(settingsForMonitor(settings, 'normal')).toMatchObject({ position: 'center', width: 320, height: 240 });
});
