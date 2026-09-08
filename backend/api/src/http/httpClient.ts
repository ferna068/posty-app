/**
 * Cliente HTTP estandarizado para todos los proveedores.
 *
 * Objetivos (ARCHITECTURE.md ADR-01):
 *  - Un único punto donde se aplican timeout, parseo de cuerpo y forma de error.
 *  - Los adaptadores no tocan `fetch` ni `AbortController` directamente.
 *  - Todo fallo se expresa como `HttpError` (respuesta no-2xx) o `HttpTransportError`
 *    (timeout / DNS / reset), nunca como una excepción genérica sin clasificar.
 */

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path absoluto o relativo al `baseUrl` del cliente. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Cuerpo JSON. Se serializa y se fija `Content-Type: application/json`. */
  json?: unknown;
  /** Cuerpo `application/x-www-form-urlencoded`. */
  form?: Record<string, string>;
  /** Override del timeout por defecto del cliente, en ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Cuerpo parseado como JSON si el `Content-Type` lo permite; si no, el texto crudo. */
  body: T;
}

/** Respuesta recibida pero con status fuera de 2xx. */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Headers,
    readonly request: { method: string; url: string },
  ) {
    super(`HTTP ${status} en ${request.method} ${request.url}`);
  }
}

/** No hubo respuesta: timeout, abort, DNS, connection reset. */
export class HttpTransportError extends Error {
  override readonly name = 'HttpTransportError';
  constructor(
    readonly reason: 'timeout' | 'aborted' | 'network',
    readonly request: { method: string; url: string },
    options?: { cause?: unknown },
  ) {
    super(`Fallo de transporte (${reason}) en ${request.method} ${request.url}`, options);
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: HttpRequestOptions['query'],
): string {
  const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return /\bapplication\/(json|.+\+json)\b/i.test(contentType);
}

export class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly defaults: { timeoutMs: number; headers?: Record<string, string> },
  ) {}

  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const method = options.method ?? 'GET';
    const url = buildUrl(this.baseUrl, options.path, options.query);

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.defaults.headers,
      ...options.headers,
    };

    let body: string | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }

    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), {
        once: true,
      });
    }

    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) init.body = body;

    let raw: Response;
    try {
      raw = await fetch(url, init);
    } catch (err) {
      const reason = classifyFetchError(err, controller.signal);
      throw new HttpTransportError(reason, { method, url }, { cause: err });
    } finally {
      clearTimeout(timeout);
    }

    const parsed = await parseBody(raw);

    if (!raw.ok) {
      throw new HttpError(raw.status, parsed, raw.headers, { method, url });
    }

    return { status: raw.status, headers: raw.headers, body: parsed as T };
  }

  get<T = unknown>(path: string, options?: Omit<HttpRequestOptions, 'path' | 'method'>) {
    return this.request<T>({ ...options, path, method: 'GET' });
  }

  post<T = unknown>(path: string, options?: Omit<HttpRequestOptions, 'path' | 'method'>) {
    return this.request<T>({ ...options, path, method: 'POST' });
  }
}

async function parseBody(raw: Response): Promise<unknown> {
  const text = await raw.text();
  if (text.length === 0) return null;
  if (isJsonContentType(raw.headers.get('content-type'))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function classifyFetchError(
  err: unknown,
  signal: AbortSignal,
): 'timeout' | 'aborted' | 'network' {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof DOMException && reason.name === 'TimeoutError') return 'timeout';
    return 'aborted';
  }
  if (err instanceof DOMException && err.name === 'AbortError') return 'aborted';
  return 'network';
}
