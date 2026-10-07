// Every [role=tab] of the main tablist is wired here: adding a tab is a button plus its tabpanel in index.html.
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.nav [role=tab]')];
const key = 'dropmeme-tab';

export function showTab(id: string, focus = false): void {
  const tab = tabs.find(item => item.id === id) ?? tabs[0]!;
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')!)!.hidden = !selected;
  }
  if (focus) tab.focus();
  try { localStorage.setItem(key, tab.id); } catch { /* Remembering the tab is only a convenience. */ }
}

for (const [i, tab] of tabs.entries()) {
  tab.onclick = () => showTab(tab.id);
  tab.onkeydown = event => {
    const next = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault(); showTab(tabs[(next + tabs.length) % tabs.length]!.id, true);
  };
}
let saved: string | null = null;
try { saved = localStorage.getItem(key); } catch { /* Private or blocked storage: start on the first tab. */ }
showTab(saved ?? '');
