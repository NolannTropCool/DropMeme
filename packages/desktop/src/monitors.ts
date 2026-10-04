import type { Monitor } from '@tauri-apps/api/window';
import type { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import type { DisplayRect, ScreenRect } from './geometry.js';

export const monitorKey = (monitor: Monitor, index: number): string => monitor.name ?? `screen-${index}`;
export const monitorScreen = (monitor: Monitor): ScreenRect => ({ x: monitor.position.x, y: monitor.position.y, width: monitor.size.width, height: monitor.size.height, scale: monitor.scaleFactor });
export function selectedMonitor(monitors: Monitor[], key: string): Monitor | undefined {
  // Migrate 0.1.0's numeric monitor indices without breaking existing settings.
  return monitors.find((monitor, index) => monitorKey(monitor, index) === key) ?? (/^\d+$/.test(key) ? monitors[Number(key)] : undefined);
}

export async function applyWindowGeometry(window: Pick<WebviewWindow, 'setPosition' | 'setSize'>, box: DisplayRect): Promise<void> {
  // Moving to a different DPI monitor can itself resize the window. Apply the final physical size afterwards.
  await window.setPosition(new PhysicalPosition(box.x, box.y));
  await window.setSize(new PhysicalSize(box.width, box.height));
  await window.setPosition(new PhysicalPosition(box.x, box.y));
}
