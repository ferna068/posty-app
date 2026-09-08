import { getEnv } from '../config/env.js';
import { HttpClient, HttpError } from '../http/httpClient.js';
import { classifyGenericError, PublishError, parseRetryAfter } from './errors.js';
import type { PublishInput, PublishResult, SocialProvider } from './types.js';

/**
 * Adaptador X / Twitter API v2.
 *
 * Publicación: `POST /2/tweets` con `{ "text": "..." }` y `Authorization: Bearer <user token>`.
 * Doc de referencia: ARCHITECTURE.md §2.3.
 */

interface TweetOk {
  data: { id: string; text: string };
}

interface TweetErrorBody {
  title?: string;
  detail?: string;
  status?: number;
  errors?: Array<{ message?: string }>;
}

/**
 * Longitud ponderada aproximada de X: los caracteres fuera de los rangos "peso 1"
 * (ASCII imprimible + Latin-1) cuentan doble. No implementa el descuento de URLs a 23;
 * para eso hace falta `twitter-text` (ARCHITECTURE.md §2.3). Suficiente como guarda previa.
 */
export function weightedLength(text: string): number {
  let weight = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const isWeightOne =
      (cp >= 0x0000 && cp <= 0x10ff) ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    weight += isWeightOne ? 1 : 2;
  }
  return weight;
}

export class TwitterProvider implements SocialProvider<'twitter'> {
  readonly id = 'twitter' as const;
  readonly capabilities = { maxTextLength: 280 };

  private readonly http: HttpClient;

  constructor(http?: HttpClient) {
    const env = getEnv();
    this.http =
      http ??
      new HttpClient(env.TWITTER_API_BASE_URL, { timeoutMs: env.PROVIDER_HTTP_TIMEOUT_MS });
  }

  async publishText(input: PublishInput<'twitter'>): Promise<PublishResult> {
    if (weightedLength(input.text) > this.capabilities.maxTextLength) {
      throw new PublishError({
        network: 'twitter',
        code: 'TEXT_TOO_LONG',
        message: `El texto supera el límite de ${this.capabilities.maxTextLength} caracteres de X.`,
      });
    }

    try {
      const res = await this.http.post<TweetOk>('/2/tweets', {
        headers: { authorization: `Bearer ${input.credentials.accessToken}` },
        json: { text: input.text },
      });

      const id = res.body.data.id;
      return {
        externalPostId: id,
        permalink: `https://x.com/i/web/status/${id}`,
        publishedAt: new Date().toISOString(),
        raw: res.body.data,
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): PublishError {
    if (error instanceof HttpError) {
      const body = (error.body ?? {}) as TweetErrorBody;
      const detail = `${body.title ?? ''} ${body.detail ?? ''} ${
        body.errors?.map((e) => e.message).join(' ') ?? ''
      }`.toLowerCase();

      if (error.status === 403 && detail.includes('duplicate')) {
        return new PublishError({
          network: 'twitter',
          code: 'DUPLICATE_CONTENT',
          message: 'X rechazó el tweet por ser contenido duplicado reciente.',
          providerStatus: 403,
          cause: error,
        });
      }

      if (error.status === 403 && /rule|policy|violat|not permitted to create/i.test(detail)) {
        return new PublishError({
          network: 'twitter',
          code: 'CONTENT_REJECTED',
          message: 'X rechazó el tweet por sus políticas de contenido.',
          providerStatus: 403,
          cause: error,
        });
      }
      // 403 sin señal de duplicado/política: normalmente la app no tiene permiso de
      // escritura o el token perdió el scope -> REAUTH_REQUIRED (vía classifyGenericError).

      if (error.status === 429) {
        const reset = error.headers.get('x-rate-limit-reset');
        const retryAfter =
          reset && Number.isFinite(Number(reset))
            ? Math.max(0, Math.ceil(Number(reset) - Date.now() / 1000))
            : parseRetryAfter(error.headers.get('retry-after'));
        return new PublishError({
          network: 'twitter',
          code: 'RATE_LIMITED',
          message: 'X ha limitado temporalmente las publicaciones. Inténtalo más tarde.',
          providerStatus: 429,
          ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
          cause: error,
        });
      }
    }

    return classifyGenericError('twitter', error);
  }
}
