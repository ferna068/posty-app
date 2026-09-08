import { z } from 'zod';
import { NETWORK_IDS, type NetworkId } from '../providers/types.js';

/**
 * Esquema de `POST /api/v1/posts/publish` (alcance de esta entrega: texto plano,
 * credenciales resueltas en la request).
 *
 * Difiere del contrato asíncrono de ARCHITECTURE.md §4 de forma deliberada: aquí el
 * fan-out es síncrono con `Promise.allSettled()` según lo pedido. La forma del
 * resultado por-target (`{ network: 'ok' | 'failed', reason }`) se mantiene.
 */

const twitterCredentials = z.object({
  accessToken: z.string().min(1),
});

const linkedinCredentials = z.object({
  accessToken: z.string().min(1),
  authorUrn: z
    .string()
    .regex(/^urn:li:(person|organization):.+/, 'authorUrn debe ser un URN de persona u organización'),
});

const facebookCredentials = z.object({
  pageId: z.string().min(1),
  pageAccessToken: z.string().min(1),
});

export const PublishRequestSchema = z
  .object({
    text: z.string().trim().min(1, 'text no puede estar vacío').max(63206, 'text demasiado largo'),
    targets: z
      .object({
        twitter: twitterCredentials.optional(),
        linkedin: linkedinCredentials.optional(),
        facebook: facebookCredentials.optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (body) => NETWORK_IDS.some((n) => body.targets[n] !== undefined),
    { message: 'Debes indicar credenciales para al menos una red', path: ['targets'] },
  );

export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export function requestedNetworks(request: PublishRequest): NetworkId[] {
  return NETWORK_IDS.filter((n) => request.targets[n] !== undefined);
}
