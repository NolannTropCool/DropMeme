import { isTauri, invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import { settingsSchema, defaultSettings, pairingResponseSchema, normalizeServerUrl, type Settings, type PairingResponse } from '@dropmeme/shared';

export interface Preferences { settings: Settings; server: string; subscription: Omit<PairingResponse, 'token'> | undefined }
let browserToken: string | undefined;
const defaults = (): Preferences => ({ settings: { ...defaultSettings }, server: '', subscription: undefined });

export async function readPreferences(): Promise<Preferences> {
  const raw = isTauri() ? await (await load('preferences.json', { defaults: {}, autoSave: false })).get<unknown>('preferences') : JSON.parse(localStorage.getItem('dropmeme-preferences') ?? 'null') as unknown;
  if (!raw || typeof raw !== 'object') return defaults();
  const v = raw as Partial<Preferences>;
  const settings = settingsSchema.safeParse(v.settings);
  let server = '';
  try { if (v.server) server = normalizeServerUrl(v.server); } catch { /* Invalid saved URLs are ignored. */ }
  const subscription = v.subscription ? pairingResponseSchema.omit({ token: true }).safeParse(v.subscription) : undefined;
  return { settings: settings.success ? settings.data : { ...defaultSettings }, server, subscription: subscription?.success ? subscription.data : undefined };
}

export async function writePreferences(value: Preferences): Promise<void> {
  // Secrets are deliberately absent from this JSON file and localStorage.
  if (isTauri()) {
    const store = await load('preferences.json', { defaults: {}, autoSave: false });
    await store.set('preferences', value); await store.save();
  } else localStorage.setItem('dropmeme-preferences', JSON.stringify(value));
}
export async function readToken(): Promise<string | undefined> {
  return isTauri() ? (await invoke<string | null>('load_token')) ?? undefined : browserToken;
}
export async function saveToken(token: string): Promise<void> {
  if (isTauri()) await invoke('save_token', { token }); else browserToken = token;
}
export async function clearToken(): Promise<void> {
  if (isTauri()) await invoke('clear_token'); else browserToken = undefined;
}
