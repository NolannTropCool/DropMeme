import { expect, test, vi } from 'vitest';
import { applyWindowGeometry, monitorKey, selectedMonitor } from '../src/monitors.js';
import type { Monitor } from '@tauri-apps/api/window';

test('moves onto the destination DPI monitor before applying the final physical dimensions', async () => {
  const calls: string[] = [];
  const window = { setPosition: vi.fn(async () => { calls.push('position'); }), setSize: vi.fn(async () => { calls.push('size'); }) };
  await applyWindowGeometry(window, { x: -3000, y: 420, width: 960, height: 640 });
  expect(calls).toEqual(['position', 'size', 'position']);
  expect(window.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 960, height: 640 }));
  expect(window.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: -3000, y: 420 }));
});
test('uses stable display names while keeping old numeric indices readable', () => {
  const monitors = [{ name: 'wide' }, { name: 'normal' }] as Monitor[];
  expect(monitorKey(monitors[0]!, 0)).toBe('wide');
  expect(selectedMonitor(monitors, 'normal')).toBe(monitors[1]);
  expect(selectedMonitor(monitors, '0')).toBe(monitors[0]);
  expect(selectedMonitor(monitors, 'disconnected')).toBeUndefined();
});
