import type { Settings } from '@dropmeme/shared';
export interface ScreenRect { x: number; y: number; width: number; height: number; scale: number }

/** Monitor coordinates are physical pixels, including negative coordinates on secondary displays. */
export function overlayGeometry(screen: ScreenRect, settings: Settings): { x: number; y: number; width: number; height: number } {
  const margin = Math.round(20 * screen.scale);
  const width = Math.min(Math.round(settings.width * screen.scale), Math.max(1, screen.width - margin * 2));
  const height = Math.min(Math.round(settings.height * screen.scale), Math.max(1, screen.height - margin * 2));
  const right = screen.x + screen.width - width - margin;
  const bottom = screen.y + screen.height - height - margin;
  const x = settings.position === 'center' ? screen.x + Math.round((screen.width - width) / 2) : settings.position.endsWith('right') ? right : screen.x + margin;
  const y = settings.position === 'center' ? screen.y + Math.round((screen.height - height) / 2) : settings.position.startsWith('bottom') ? bottom : screen.y + margin;
  return { x, y, width, height };
}
