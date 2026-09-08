import { HttpError, HttpTransportError } from '../http/httpClient.js';
import type { NetworkId } from './types.js';

/**
 * Modelo de errores de publicación (ARCHITECTURE.md §5.2, subconjunto a nivel target).
 *
 * Cada adaptador traduce el error HTTP del proveedor a uno de estos códigos en su
 * `normalizeError`. El resto del sistema solo razona sobre `PublishErrorCode`.
 */
export type PublishErrorCode =
  | 'REAUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'DUPLICATE_CONTENT'
  | 'CONTENT_REJECTED'
  | 'TEXT_TOO_LONG'
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR';

const RETRYABLE: ReadonlySet<PublishErrorCode> = new Set<PublishErrorCode>([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export interface PublishErrorInit {
  network: NetworkId;
  code: PublishErrorCode;
  /** Mensaje apto para el usuario final. Sin jerga del proveedor, sin credenciales. */
  message: string;
  /** Status HTTP del proveedor, si lo hubo. */
  providerStatus?: number;
  /** Segundos sugeridos de espera (RATE_LIMITED). */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class PublishError extends Error {
  override readonly name = 'PublishError';
  readonly network: NetworkId;
  readonly code: PublishErrorCode;
  readonly providerStatus: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly retryable: boolean;

  constructor(init: PublishErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.network = init.network;
    this.code = init.code;
    this.providerStatus = init.providerStatus;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.retryable = RETRYABLE.has(init.code);
  }
}

/**
 * Clasificación genérica compartida por los tres adaptadores: cubre transporte y
 * los status "universales". Las señales específicas de cada proveedor
 * (subcódigos, `serviceErrorCode`, `OAuthException`) se resuelven ANTES de llamar aquí.
 */
export function classifyGenericError(network: NetworkId, error: unknown): PublishError {
  if (error instanceof PublishError) return error;

  if (error instanceof HttpTransportError) {
    return new PublishError({
      network,
      code: 'PROVIDER_UNAVAILABLE',
      message:
        error.reason === 'timeout'
          ? `${labelFor(network)} no respondió a tiempo. Inténtalo de nuevo en unos minutos.`
          : `No se pudo contactar con ${labelFor(network)}. Inténtalo de nuevo en unos minutos.`,
      cause: error,
    });
  }

  if (error instanceof HttpError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return new PublishError({
        network,
        code: 'REAUTH_REQUIRED',
        message: `La conexión con ${labelFor(network)} no es válida. Vuelve a conectar la cuenta.`,
        providerStatus: status,
        cause: error,
      });
    }
    if (status === 429) {
      const retryAfterSeconds = parseRetryAfter(error.headers.get('retry-after'));
      return new PublishError({
        network,
        code: 'RATE_LIMITED',
        message: `${labelFor(network)} ha limitado temporalmente las publicaciones. Inténtalo más tarde.`,
        providerStatus: status,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        cause: error,
      });
    }
    if (status >= 500) {
      return new PublishError({
        network,
        code: 'PROVIDER_UNAVAILABLE',
        message: `${labelFor(network)} está teniendo problemas. Inténtalo de nuevo en unos minutos.`,
        providerStatus: status,
        cause: error,
      });
    }
    if (status === 400 || status === 422) {
      return new PublishError({
        network,
        code: 'INVALID_REQUEST',
        message: `${labelFor(network)} rechazó la publicación.`,
        providerStatus: status,
        cause: error,
      });
    }
    return new PublishError({
      network,
      code: 'INTERNAL_ERROR',
      message: `Error inesperado al publicar en ${labelFor(network)}.`,
      providerStatus: status,
      cause: error,
    });
  }

  return new PublishError({
    network,
    code: 'INTERNAL_ERROR',
    message: `Error inesperado al publicar en ${labelFor(network)}.`,
    cause: error,
  });
}

export function labelFor(network: NetworkId): string {
  switch (network) {
    case 'twitter':
      return 'X';
    case 'linkedin':
      return 'LinkedIn';
    case 'facebook':
      return 'Facebook';
  }
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.ceil(asNumber);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
  }
  return undefined;
}
