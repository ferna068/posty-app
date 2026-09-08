import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { logger } from './lib/logger.js';

const env = getEnv();
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('server.listening', { port: env.PORT, env: env.NODE_ENV });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('server.port_in_use', { port: env.PORT });
  } else {
    logger.error('server.error', { error: err.message });
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('server.shutdown', { signal });
    server.close(() => process.exit(0));
  });
}
