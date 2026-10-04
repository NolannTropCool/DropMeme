import { beforeEach, expect, test, vi } from 'vitest';
import { defaultSettings } from '@dropmeme/shared';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), getByLabel: vi.fn(), availableMonitors: vi.fn(), primaryMonitor: vi.fn(),
  complete: undefined as ((event: { payload: { save: boolean } }) => void) | undefined,
  close: undefined as ((event: { preventDefault(): void }) => void) | undefined,
  unlisten: vi.fn(), unclose: vi.fn(),
  window: { setPosition: vi.fn(), setSize: vi.fn(), show: vi.fn(), destroy: vi.fn(), setFocus: vi.fn(), onCloseRequested: vi.fn(), outerPosition: vi.fn(), innerSize: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: mocks.getByLabel } }));
vi.mock('@tauri-apps/api/window', () => ({ availableMonitors: mocks.availableMonitors, primaryMonitor: mocks.primaryMonitor }));
import { placeOverlay } from '../src/placement-controller.js';

const wide = { name: 'wide', position: { x: -5120, y: 0 }, size: { width: 5120, height: 1440 }, scaleFactor: 1 };
const normal = { name: 'normal', position: { x: 0, y: 0 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined); mocks.getByLabel.mockResolvedValue(mocks.window);
  mocks.availableMonitors.mockResolvedValue([wide, normal]); mocks.primaryMonitor.mockResolvedValue(wide);
  mocks.listen.mockImplementation(async (_event: string, callback: typeof mocks.complete) => { mocks.complete = callback; return mocks.unlisten; });
  mocks.window.onCloseRequested.mockImplementation(async (callback: typeof mocks.close) => { mocks.close = callback; return mocks.unclose; });
  mocks.window.show.mockImplementation(async () => { mocks.complete?.({ payload: { save: true } }); });
  mocks.window.setFocus.mockResolvedValue(undefined);
  mocks.window.outerPosition.mockResolvedValue({ x: 80, y: 150 }); mocks.window.innerSize.mockResolvedValue({ width: 900, height: 600 });
});

test('a frame dragged from the ultrawide onto a different DPI screen saves that screen and its logical size', async () => {
  const settings = await placeOverlay(defaultSettings);
  expect(mocks.invoke).toHaveBeenCalledWith('create_placement');
  expect(settings).toMatchObject({ monitor: 'normal', position: 'custom', width: 600, height: 400 });
  expect(settings?.customX).toBeCloseTo(80 / 1660);
  expect(settings?.customY).toBeCloseTo(150 / 840);
  expect(settings?.layouts.normal).toMatchObject({ width: 600, height: 400 });
  expect(mocks.unlisten).toHaveBeenCalledOnce(); expect(mocks.unclose).toHaveBeenCalledOnce(); expect(mocks.window.destroy).toHaveBeenCalledOnce();
});
test('closing the placement window cancels without reading or saving its geometry', async () => {
  const preventDefault = vi.fn();
  mocks.window.show.mockImplementation(async () => { mocks.close?.({ preventDefault }); });
  expect(await placeOverlay(defaultSettings)).toBeUndefined();
  expect(preventDefault).toHaveBeenCalledOnce(); expect(mocks.window.innerSize).not.toHaveBeenCalled();
  expect(mocks.window.destroy).toHaveBeenCalledOnce();
});
test('a failed native setup destroys the transient frame and releases event listeners', async () => {
  mocks.window.setFocus.mockRejectedValueOnce(new Error('Focus failed'));
  await expect(placeOverlay(defaultSettings)).rejects.toThrow('Focus failed');
  expect(mocks.unlisten).toHaveBeenCalledOnce(); expect(mocks.unclose).toHaveBeenCalledOnce(); expect(mocks.window.destroy).toHaveBeenCalledOnce();
});
