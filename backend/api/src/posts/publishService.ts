import { logger } from '../lib/logger.js';
import { PublishError, type PublishErrorCode } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { NetworkId, ProviderCredentials } from '../providers/types.js';
import { requestedNetworks, type PublishRequest } from './publishRequest.js';

/**
 * Orquestación del fan-out.
 *
 * Ejecuta la publicación en cada red destino EN PARALELO con `Promise.allSettled()`
 * y normaliza el resultado a un estado individual por plataforma. Un fallo en una
 * red nunca aborta ni afecta a las demás (ARCHITECTURE.md ADR-03).
 */

export type TargetOk = {
  status: 'ok';
  id: string;
  permalink: string | null;
  publishedAt: string;
};

export type TargetFailed = {
  status: 'failed';
  /** Motivo apto para el usuario final. */
  reason: string;
  code: PublishErrorCode;
  retryable: boolean;
  providerStatus?: number;
  retryAfterSeconds?: number;
};

export type TargetResult = TargetOk | TargetFailed;

export type PublishOutcome = 'completed' | 'partial' | 'failed';

export interface PublishResponse {
  text: string;
  /** Estado individual por plataforma: `{ twitter: {...}, linkedin: {...} }`. */
  results: Partial<Record<NetworkId, TargetResult>>;
  summary: {
    outcome: PublishOutcome;
    ok: NetworkId[];
    failed: NetworkId[];
  };
}

export interface PublishService {
  publish(request: PublishRequest, ctx: { requestId: string }): Promise<PublishResponse>;
}

export function createPublishService(registry: ProviderRegistry): PublishService {
  return {
    async publish(request, ctx) {
      const networks = requestedNetworks(request);

      const settled = await Promise.allSettled(
        networks.map((network) => publishToNetwork(registry, network, request, ctx.requestId)),
      );

      const results: Partial<Record<NetworkId, TargetResult>> = {};
      const ok: NetworkId[] = [];
      const failed: NetworkId[] = [];

      networks.forEach((network, index) => {
        const entry = settled[index]!;
        if (entry.status === 'fulfilled') {
          results[network] = entry.value;
          (entry.value.status === 'ok' ? ok : failed).push(network);
        } else {
          // Red de seguridad: un adaptador SIEMPRE debería lanzar PublishError,
          // pero si escapa cualquier otra cosa no puede tumbar el fan-out.
          results[network] = normalizeUnexpected(network, entry.reason);
          failed.push(network);
        }
      });

      const outcome: PublishOutcome =
        failed.length === 0 ? 'completed' : ok.length === 0 ? 'failed' : 'partial';

      logger.info('publish.fan_out.done', {
        requestId: ctx.requestId,
        outcome,
        ok,
        failed,
      });

      return { text: request.text, results, summary: { outcome, ok, failed } };
    },
  };
}

async function publishToNetwork(
  registry: ProviderRegistry,
  network: NetworkId,
  request: PublishRequest,
  requestId: string,
): Promise<TargetResult> {
  const provider = registry.get(network);
  const credentials = request.targets[network] as ProviderCredentials[typeof network];

  try {
    const result = await provider.publishText({
      text: request.text,
      credentials,
      requestId,
    });
    logger.info('publish.target.ok', { requestId, network, externalPostId: result.externalPostId });
    return {
      status: 'ok',
      id: result.externalPostId,
      permalink: result.permalink,
      publishedAt: result.publishedAt,
    };
  } catch (error) {
    const normalized =
      error instanceof PublishError ? error : (normalizeUnexpectedError(network, error));
    logger.warn('publish.target.failed', {
      requestId,
      network,
      code: normalized.code,
      providerStatus: normalized.providerStatus,
    });
    return toFailed(normalized);
  }
}

function toFailed(error: PublishError): TargetFailed {
  return {
    status: 'failed',
    reason: error.message,
    code: error.code,
    retryable: error.retryable,
    ...(error.providerStatus !== undefined ? { providerStatus: error.providerStatus } : {}),
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}

function normalizeUnexpectedError(network: NetworkId, error: unknown): PublishError {
  return new PublishError({
    network,
    code: 'INTERNAL_ERROR',
    message: 'Error inesperado al publicar.',
    cause: error,
  });
}

function normalizeUnexpected(network: NetworkId, reason: unknown): TargetFailed {
  return toFailed(normalizeUnexpectedError(network, reason));
}
