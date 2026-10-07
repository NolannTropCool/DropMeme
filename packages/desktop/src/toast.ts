/** Non-blocking feedback in the #toasts live region. Errors stay longer so they can be read. */
export function toast(text: string, tone: 'success' | 'error' = 'success'): void {
  const region = document.getElementById('toasts')!;
  const item = document.createElement('p'); item.className = `toast ${tone}`; item.textContent = text;
  region.append(item);
  while (region.childElementCount > 3) region.firstElementChild!.remove();
  setTimeout(() => item.remove(), tone === 'error' ? 7000 : 4000);
}
