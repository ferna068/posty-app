import { z } from 'zod';

/**
 * Configuración de entorno.
 *
 * Solo contiene lo que la capa de integración necesita: versiones de API pinneadas
 * (Meta y LinkedIn versionan de forma agresiva — ver ARCHITECTURE.md §8.1) y los
 * presupuestos de latencia hacia cada proveedor.
 *
 * Los `client_secret` / credenciales OAuth NO viven aquí: los tokens de publicación
 * llegan resueltos en la request (en producción, desde el TokenVault — ARCHITECTURE.md §3.5).
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Timeout por llamada a un proveedor, en ms. Un target lento no puede colgar el fan-out. */
  PROVIDER_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  /** X / Twitter API v2 */
  TWITTER_API_BASE_URL: z.string().url().default('https://api.twitter.com'),

  /** LinkedIn REST API */
  LINKEDIN_API_BASE_URL: z.string().url().default('https://api.linkedin.com'),
  /** Header `LinkedIn-Version: AAAAMM` — obligatorio en /rest/*. */
  LINKEDIN_API_VERSION: z
    .string()
    .regex(/^\d{6}$/, 'LINKEDIN_API_VERSION debe tener formato AAAAMM')
    .default('202409'),

  /** Meta Graph API — Facebook Pages */
  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'META_API_VERSION debe tener formato vXX.X')
    .default('v21.0'),
  /**
   * App secret de Meta. Si está presente se envía `appsecret_proof` en cada llamada
   * (ARCHITECTURE.md §2.5). Opcional en desarrollo.
   */
  META_APP_SECRET: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Solo para tests: fuerza una relectura del entorno. */
export function resetEnvCache(): void {
  cached = undefined;
}
