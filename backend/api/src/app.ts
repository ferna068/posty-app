import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from './lib/logger.js';
import { createPublishHandler } from './posts/publishHandler.js';
import type { PublishService } from './posts/publishService.js';
import { createPublishService } from './posts/publishService.js';
import { createProviderRegistry, type ProviderRegistry } from './providers/registry.js';

export interface AppDeps {
  registry?: ProviderRegistry;
  publishService?: PublishService;
}

export function createApp(deps: AppDeps = {}): Express {
  const registry = deps.registry ?? createProviderRegistry();
  const publishService = deps.publishService ?? createPublishService(registry);

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/v1/posts/publish', asyncHandler(createPublishHandler(publishService)));

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} no existe` } });
  });

  // Error handler
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (res.getHeader('x-request-id') as string | undefined) ?? `req_${randomUUID()}`;

    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        error: { code: 'INVALID_JSON', message: 'El cuerpo no es JSON válido.', requestId },
      });
      return;
    }

    logger.error('request.unhandled_error', {
      requestId,
      method: req.method,
      path: req.path,
      error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
    });

    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor.', requestId },
    });
  });

  return app;
}

function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
