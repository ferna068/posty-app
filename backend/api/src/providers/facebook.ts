import { createHmac } from 'node:crypto';
import { getEnv } from '../config/env.js';
import { HttpClient, HttpError } from '../http/httpClient.js';
import { classifyGenericError, PublishError } from './errors.js';
import type { PublishInput, PublishResult, SocialProvider } from './types.js';

/**
 * Adaptador Meta Graph API — Facebook Pages.
 *
 * Publicación: `POST /{version}/{page-id}/feed` con `{ message, access_token }`.
 * El token es el **Page Access Token**, no el user token. Si hay app secret
 * configurado se añade `appsecret_proof` (ARCHITECTURE.md §2.5).
 */

interface FeedOk {
  id: string; // `{page-id}_{post-id}`
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export function appsecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

export class FacebookProvider implements SocialProvider<'facebook'> {
  readonly id = 'facebook' as const;
  readonly capabilities = { maxTextLength: 63206 };

  private readonly http: HttpClient;
  private readonly apiVersion: string;
  private readonly appSecret: string | undefined;

  constructor(http?: HttpClient) {
    const env = getEnv();
    this.apiVersion = env.META_API_VERSION;
    this.appSecret = env.META_APP_SECRET;
    this.http =
      http ?? new HttpClient(env.META_GRAPH_BASE_URL, { timeoutMs: env.PROVIDER_HTTP_TIMEOUT_MS });
  }

  async publishText(input: PublishInput<'facebook'>): Promise<PublishResult> {
    if ([...input.text].length > this.capabilities.maxTextLength) {
      throw new PublishError({
        network: 'facebook',
        code: 'TEXT_TOO_LONG',
        message: `El texto supera el límite de ${this.capabilities.maxTextLength} caracteres de Facebook.`,
      });
    }

    const { pageId, pageAccessToken } = input.credentials;
    const form: Record<string, string> = {
      message: input.text,
      access_token: pageAccessToken,
    };
    if (this.appSecret) {
      form['appsecret_proof'] = appsecretProof(pageAccessToken, this.appSecret);
    }

    try {
      const res = await this.http.post<FeedOk>(`/${this.apiVersion}/${encodeURIComponent(pageId)}/feed`, {
        form,
      });

      const id = res.body.id;
      return {
        externalPostId: id,
        permalink: `https://www.facebook.com/${id.replace('_', '/posts/')}`,
        publishedAt: new Date().toISOString(),
        raw: res.body,
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): PublishError {
    if (error instanceof HttpError) {
      const graphError = ((error.body ?? {}) as GraphErrorBody).error ?? {};
      const code = graphError.code;

      // OAuthException 190 (token) o 200 (permiso faltante) -> reconexión.
      if (code === 190 || code === 200 || code === 10) {
        return new PublishError({
          network: 'facebook',
          code: 'REAUTH_REQUIRED',
          message:
            'La conexión con Facebook ha expirado o le faltan permisos. Vuelve a conectar la Página.',
          providerStatus: error.status,
          cause: error,
        });
      }

      // 4 (app limit) / 17 (user limit) / 32 (page limit) / 613 (calls per hour).
      if (code === 4 || code === 17 || code === 32 || code === 613) {
        return new PublishError({
          network: 'facebook',
          code: 'RATE_LIMITED',
          message: 'Facebook ha limitado temporalmente las publicaciones. Inténtalo más tarde.',
          providerStatus: error.status,
          cause: error,
        });
      }

      // 1 (unknown) / 2 (service) -> transitorio.
      if (code === 1 || code === 2) {
        return new PublishError({
          network: 'facebook',
          code: 'PROVIDER_UNAVAILABLE',
          message: 'Facebook está teniendo problemas. Inténtalo de nuevo en unos minutos.',
          providerStatus: error.status,
          cause: error,
        });
      }

      // 368 (bloqueo temporal por políticas) / 1404xxx (contenido).
      if (code === 368 || graphError.type === 'OAuthException') {
        return new PublishError({
          network: 'facebook',
          code: 'CONTENT_REJECTED',
          message: 'Facebook rechazó la publicación por sus políticas.',
          providerStatus: error.status,
          cause: error,
        });
      }
    }

    return classifyGenericError('facebook', error);
  }
}
