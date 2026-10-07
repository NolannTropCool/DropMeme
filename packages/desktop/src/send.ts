import { gifSearchResponseSchema, type GifSearchResponse } from '@dropmeme/shared';

const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
async function refusal(response: Response, fallback: string): Promise<Error> {
  const result: unknown = await response.json().catch(() => null);
  return new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : fallback);
}

/** Shared by the main composer and the quick-send relay. Only the main window holds the token. */
async function post(server: string, token: string, path: string, body: BodyInit, json = false): Promise<void> {
  const response = await fetch(`${server}${path}`, {
    method: 'POST', headers: { ...headers(token), ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw await refusal(response, 'Envoi refusé par le serveur.');
}

export const sendText = (server: string, token: string, text: string, recipientId?: string): Promise<void> =>
  post(server, token, '/v2/send/text', JSON.stringify({ text, recipientId }), true);

export const sendGif = (server: string, token: string, id: string): Promise<void> =>
  post(server, token, '/v2/send/gif', JSON.stringify({ id }), true);

export function sendFile(server: string, token: string, file: File, recipientId?: string): Promise<void> {
  const body = new FormData(); body.append('file', file);
  return post(server, token, `/v2/send/file${recipientId ? `?recipientId=${encodeURIComponent(recipientId)}` : ''}`, body);
}

export async function searchGifs(server: string, token: string, q: string, page: number, signal: AbortSignal): Promise<GifSearchResponse> {
  const response = await fetch(`${server}/v2/gifs/search?${new URLSearchParams({ q, page: String(page) })}`, {
    headers: headers(token), credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw await refusal(response, 'La recherche de GIF est indisponible pour le moment.');
  const result = gifSearchResponseSchema.safeParse(await response.json().catch(() => null));
  if (!result.success) throw new Error('Réponse de recherche invalide.');
  return result.data;
}
