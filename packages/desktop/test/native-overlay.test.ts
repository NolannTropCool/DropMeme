import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), emitTo: vi.fn(), listen: vi.fn(), getByLabel: vi.fn(),
  window: { show: vi.fn(), setIgnoreCursorEvents: vi.fn() },
  unlisten: vi.fn(), ready: undefined as (() => void) | undefined,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: mocks.emitTo, listen: mocks.listen }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: mocks.getByLabel } }));
import { openOverlay } from '../src/native-overlay.js';

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.ready = undefined;
  mocks.invoke.mockResolvedValue(undefined);
  mocks.getByLabel.mockResolvedValue(mocks.window);
  mocks.listen.mockImplementation(async (_event: string, callback: () => void) => { mocks.ready = callback; return mocks.unlisten; });
  mocks.emitTo.mockImplementation(async () => { mocks.ready?.(); });
});
afterEach(() => { vi.useRealTimers(); });

test('shows the transparent click-through window before waiting for ready and probes an existing webview', async () => {
  mocks.emitTo.mockImplementation(async () => {
    expect(mocks.window.show).toHaveBeenCalledOnce();
    expect(mocks.window.setIgnoreCursorEvents).toHaveBeenCalledWith(true);
    mocks.ready?.();
  });
  expect(await openOverlay()).toBe(mocks.window);
  expect(mocks.invoke).toHaveBeenCalledWith('create_overlay');
  expect(mocks.emitTo).toHaveBeenCalledWith('overlay', 'overlay-probe');
  expect(mocks.unlisten).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('a lost startup event times out cleanly and a subsequent attempt can reuse the same webview', async () => {
  mocks.emitTo.mockResolvedValue(undefined);
  const failed = expect(openOverlay()).rejects.toThrow('La superposition ne répond pas');
  await vi.advanceTimersByTimeAsync(10_001); await failed;
  expect(vi.getTimerCount()).toBe(0);
  mocks.emitTo.mockImplementation(async () => { mocks.ready?.(); });
  expect(await openOverlay()).toBe(mocks.window);
});

test('bounds even a stuck native creation command', async () => {
  mocks.invoke.mockImplementation(() => new Promise(() => {}));
  const failed = expect(openOverlay()).rejects.toThrow('La superposition ne répond pas');
  await vi.advanceTimersByTimeAsync(10_001); await failed;
  expect(mocks.unlisten).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('late native creation after a timeout does not leave a probing timer running', async () => {
  let complete!: () => void;
  mocks.invoke.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  const failed = expect(openOverlay()).rejects.toThrow('La superposition ne répond pas');
  await vi.advanceTimersByTimeAsync(10_001); await failed;
  complete(); await vi.advanceTimersByTimeAsync(1);
  expect(mocks.window.show).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
