import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';
import { PublishRequestSchema } from './publishRequest.js';
import type { PublishService } from './publishService.js';

/**
 * Handler HTTP de `POST /api/v1/posts/publish`.
 *
 * Códigos de estado:
 *  - `200 OK`             todas las redes publicaron (`outcome: "completed"`)
 *  - `207 Multi-Status`   fallo parcial (`outcome: "partial"`) — el cuerpo trae el detalle
 *  - `422 Unprocessable`  el cuerpo no cumple el esquema
 *  - `502 Bad Gateway`    ninguna red publicó (`outcome: "failed"`)
 *
 * El fallo parcial NO es un error: el cuerpo siempre lleva el estado individual por red.
 */
export function createPublishHandler(service: PublishService) {
  return async function publishHandler(req: Request, res: Response): Promise<void> {
    const requestId = headerString(req.headers['x-request-id']) ?? `req_${randomUUID()}`;
    res.setHeader('x-request-id', requestId);

    let request;
    try {
      request = PublishRequestSchema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'El cuerpo de la petición no es válido.',
            requestId,
            details: error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        });
        return;
      }
      throw error;
    }

    const response = await service.publish(request, { requestId });

    const httpStatus =
      response.summary.outcome === 'completed'
        ? 200
        : response.summary.outcome === 'partial'
          ? 207
          : 502;

    logger.info('publish.request.handled', {
      requestId,
      httpStatus,
      outcome: response.summary.outcome,
    });

    res.status(httpStatus).json({ data: response, meta: { requestId } });
  };
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
