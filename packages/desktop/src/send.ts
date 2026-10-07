/** Shared by the main composer and the quick-send relay. Only the main window holds the token. */
async function post(server: string, token: string, path: string, body: BodyInit, json = false): Promise<void> {
  const response = await fetch(`${server}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(90_000),
  });
  if (response.ok) return;
  const result: unknown = await response.json().catch(() => null);
  throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'Envoi refusé par le serveur.');
}

export const sendText = (server: string, token: string, text: string, recipientId?: string): Promise<void> =>
  post(server, token, '/v2/send/text', JSON.stringify({ text, recipientId }), true);

export function sendFile(server: string, token: string, file: File, recipientId?: string): Promise<void> {
  const body = new FormData(); body.append('file', file);
  return post(server, token, `/v2/send/file${recipientId ? `?recipientId=${encodeURIComponent(recipientId)}` : ''}`, body);
}
