import { vi } from 'vitest';

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Sustituye `globalThis.fetch` por una cola de respuestas. Devuelve las requests
 * capturadas para poder hacer aserciones sobre headers/cuerpo.
 */
export function stubFetch(responses: StubResponse[]): { calls: CapturedRequest[] } {
  const queue = [...responses];
  const calls: CapturedRequest[] = [];

  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const next = queue.shift();
    if (!next) throw new Error('stubFetch: no hay más respuestas en cola');

    const status = next.status ?? 200;
    const respHeaders = new Headers({ 'content-type': 'application/json', ...next.headers });
    const payload =
      next.body === undefined ? '' : typeof next.body === 'string' ? next.body : JSON.stringify(next.body);

    return new Response(payload, { status, headers: respHeaders });
  });

  return { calls };
}
