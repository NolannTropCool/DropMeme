import type { Settings } from '@dropmeme/shared';
export interface ScreenRect { x: number; y: number; width: number; height: number; scale: number }
export interface DisplayRect { x: number; y: number; width: number; height: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Monitor coordinates are physical pixels, including negative coordinates on secondary displays. */
export function overlayGeometry(screen: ScreenRect, settings: Settings): { x: number; y: number; width: number; height: number } {
  const margin = settings.position === 'custom' ? 0 : Math.min(Math.round(20 * screen.scale), Math.floor(Math.min(screen.width, screen.height) / 2));
  const width = Math.min(Math.round(settings.width * screen.scale), Math.max(1, screen.width - margin * 2));
  const height = Math.min(Math.round(settings.height * screen.scale), Math.max(1, screen.height - margin * 2));
  const right = screen.x + screen.width - width - margin;
  const bottom = screen.y + screen.height - height - margin;
  const x = settings.position === 'custom' ? screen.x + Math.round((screen.width - width) * settings.customX) : settings.position === 'center' ? screen.x + Math.round((screen.width - width) / 2) : settings.position.endsWith('right') ? right : screen.x + margin;
  const y = settings.position === 'custom' ? screen.y + Math.round((screen.height - height) * settings.customY) : settings.position === 'center' ? screen.y + Math.round((screen.height - height) / 2) : settings.position.startsWith('bottom') ? bottom : screen.y + margin;
  return { x, y, width, height };
}

/** Save logical size and relative placement, not desktop-global pixels: survives DPI/resolution changes. */
export function placementSettings(screen: ScreenRect, box: DisplayRect, settings: Settings, monitor: string): Settings {
  const width = clamp(Math.round(box.width / screen.scale), 160, 8192);
  const height = clamp(Math.round(box.height / screen.scale), 120, 4320);
  const x = clamp((box.x - screen.x) / Math.max(1, screen.width - Math.min(screen.width, width * screen.scale)), 0, 1);
  const y = clamp((box.y - screen.y) / Math.max(1, screen.height - Math.min(screen.height, height * screen.scale)), 0, 1);
  return { ...settings, monitor, position: 'custom', width, height, customX: x, customY: y, layouts: { ...settings.layouts, [monitor]: { position: 'custom', x, y, width, height } } };
}

export function settingsForMonitor(settings: Settings, monitor: string): Settings {
  const saved = settings.layouts[monitor];
  return saved ? { ...settings, monitor, position: saved.position, customX: saved.x, customY: saved.y, width: saved.width, height: saved.height } : { ...settings, monitor, position: 'bottom-right' };
}

/** A dragged frame may cross screens; choose the screen containing most of its area. */
export function screenForBox(screens: ScreenRect[], box: DisplayRect): number {
  let best = 0; let largest = -1;
  screens.forEach((screen, index) => {
    const area = Math.max(0, Math.min(box.x + box.width, screen.x + screen.width) - Math.max(box.x, screen.x)) * Math.max(0, Math.min(box.y + box.height, screen.y + screen.height) - Math.max(box.y, screen.y));
    if (area > largest) { largest = area; best = index; }
  });
  return best;
}
