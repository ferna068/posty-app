import { getEnv } from '../config/env.js';
import { HttpClient, HttpError } from '../http/httpClient.js';
import { classifyGenericError, PublishError } from './errors.js';
import type { PublishInput, PublishResult, SocialProvider } from './types.js';

/**
 * Adaptador LinkedIn REST API.
 *
 * Publicación: `POST /rest/posts` con headers `LinkedIn-Version` y
 * `X-Restli-Protocol-Version: 2.0.0`. La respuesta trae el URN del share en el
 * header `x-restli-id`. Doc de referencia: ARCHITECTURE.md §2.4.
 */

interface LinkedInErrorBody {
  message?: string;
  serviceErrorCode?: number;
  code?: string;
  status?: number;
}

/**
 * "Little Text Format": estos caracteres deben ir escapados con `\` en `commentary`.
 * El texto entra crudo al sistema y solo se transforma aquí, en el borde
 * (ARCHITECTURE.md §2.4).
 */
const LI_RESERVED = /([\\()\[\]{}<>@|~_*#])/g;

export function escapeCommentary(text: string): string {
  return text.replace(LI_RESERVED, '\\$1');
}

export class LinkedInProvider implements SocialProvider<'linkedin'> {
  readonly id = 'linkedin' as const;
  readonly capabilities = { maxTextLength: 3000 };

  private readonly http: HttpClient;
  private readonly apiVersion: string;

  constructor(http?: HttpClient) {
    const env = getEnv();
    this.apiVersion = env.LINKEDIN_API_VERSION;
    this.http =
      http ??
      new HttpClient(env.LINKEDIN_API_BASE_URL, {
        timeoutMs: env.PROVIDER_HTTP_TIMEOUT_MS,
        headers: {
          'linkedin-version': this.apiVersion,
          'x-restli-protocol-version': '2.0.0',
        },
      });
  }

  async publishText(input: PublishInput<'linkedin'>): Promise<PublishResult> {
    if ([...input.text].length > this.capabilities.maxTextLength) {
      throw new PublishError({
        network: 'linkedin',
        code: 'TEXT_TOO_LONG',
        message: `El texto supera el límite de ${this.capabilities.maxTextLength} caracteres de LinkedIn.`,
      });
    }

    const payload = {
      author: input.credentials.authorUrn,
      commentary: escapeCommentary(input.text),
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };

    try {
      const res = await this.http.post('/rest/posts', {
        headers: { authorization: `Bearer ${input.credentials.accessToken}` },
        json: payload,
      });

      const urn =
        res.headers.get('x-restli-id') ??
        res.headers.get('x-linkedin-id') ??
        (isRecord(res.body) && typeof res.body['id'] === 'string' ? res.body['id'] : null);

      if (!urn) {
        throw new PublishError({
          network: 'linkedin',
          code: 'INTERNAL_ERROR',
          message: 'LinkedIn aceptó la publicación pero no devolvió un identificador.',
        });
      }

      return {
        externalPostId: urn,
        permalink: `https://www.linkedin.com/feed/update/${urn}`,
        publishedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): PublishError {
    if (error instanceof HttpError) {
      const body = (error.body ?? {}) as LinkedInErrorBody;

      // Token inválido/expirado o permiso denegado sobre w_member_social.
      if (
        error.status === 401 ||
        body.serviceErrorCode === 65600 ||
        (error.status === 403 && (body.code === 'ACCESS_DENIED' || /w_member_social/i.test(body.message ?? '')))
      ) {
        return new PublishError({
          network: 'linkedin',
          code: 'REAUTH_REQUIRED',
          message: 'La conexión con LinkedIn ha expirado. Vuelve a conectar la cuenta para publicar.',
          providerStatus: error.status,
          cause: error,
        });
      }

      if (error.status === 422 || (error.status === 400 && /duplicate/i.test(body.message ?? ''))) {
        return new PublishError({
          network: 'linkedin',
          code: /duplicate/i.test(body.message ?? '') ? 'DUPLICATE_CONTENT' : 'INVALID_REQUEST',
          message: 'LinkedIn rechazó la publicación.',
          providerStatus: error.status,
          cause: error,
        });
      }
    }

    return classifyGenericError('linkedin', error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
