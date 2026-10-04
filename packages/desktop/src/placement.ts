import { isTauri } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './placement.css';

const $ = (id: string) => document.getElementById(id)!;
const report = (error: unknown) => { $('placement-error').textContent = error instanceof Error ? error.message : String(error); };
function send(type: string, payload: unknown): void {
  if (isTauri()) void emitTo('main', type, payload).catch(report);
  else parent.postMessage({ type, payload }, location.origin);
}
$('save').onclick = () => send('placement-complete', { save: true });
$('cancel').onclick = () => send('placement-complete', { save: false });
window.addEventListener('keydown', event => { if (event.key === 'Escape') send('placement-complete', { save: false }); });
for (const [id, kind] of [['drag', 'move'], ['resize', 'resize']] as const) {
  $(id).onpointerdown = event => {
    if (event.button !== 0) return;
    if (isTauri()) {
      const win = getCurrentWindow();
      void (kind === 'move' ? win.startDragging() : win.startResizeDragging('SouthEast')).catch(report);
      return;
    }
    const x = event.screenX; const y = event.screenY;
    $(id).setPointerCapture(event.pointerId);
    send('placement-gesture', { kind, start: true, dx: 0, dy: 0 });
    $(id).onpointermove = next => send('placement-gesture', { kind, start: false, dx: next.screenX - x, dy: next.screenY - y });
    $(id).onpointerup = () => { $(id).onpointermove = null; };
  };
}
const dimensions = () => { $('dimensions').textContent = `${innerWidth} × ${innerHeight} px`; };
window.addEventListener('resize', dimensions); dimensions();
