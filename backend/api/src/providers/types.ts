/**
 * Contrato común que implementan los tres adaptadores (ARCHITECTURE.md §1.3, recortado
 * al alcance de esta entrega: publicación de texto).
 *
 * Regla de oro: ninguna capa por encima de `providers/**` conoce URLs, headers,
 * scopes ni códigos de error de terceros.
 */

export type NetworkId = 'twitter' | 'linkedin' | 'facebook';

export const NETWORK_IDS: readonly NetworkId[] = ['twitter', 'linkedin', 'facebook'];

/**
 * Credenciales ya resueltas para una red. En producción las entrega el TokenVault
 * (ARCHITECTURE.md §3.5); aquí llegan en la request para mantener la capa testeable.
 */
export interface TwitterCredentials {
  /** OAuth 2.0 user access token con scope `tweet.write`. */
  accessToken: string;
}

export interface LinkedInCredentials {
  /** OAuth 2.0 member access token con scope `w_member_social`. */
  accessToken: string;
  /** URN del autor, p.ej. `urn:li:person:xxxx` (el `sub` de /v2/userinfo). */
  authorUrn: string;
}

export interface FacebookCredentials {
  /** ID numérico de la Página. */
  pageId: string;
  /** Page Access Token (no el user token) — ARCHITECTURE.md §2.5. */
  pageAccessToken: string;
}

export interface ProviderCredentials {
  twitter: TwitterCredentials;
  linkedin: LinkedInCredentials;
  facebook: FacebookCredentials;
}

export interface PublishInput<N extends NetworkId = NetworkId> {
  /** Texto canónico, sin transformar. Cada adaptador aplica su propio formateo/escapado. */
  text: string;
  credentials: ProviderCredentials[N];
  /** Correlación para logs y trazas. */
  requestId: string;
}

export interface PublishResult {
  /** ID del post en el proveedor. */
  externalPostId: string;
  /** URL pública si el proveedor la expone o si puede construirse de forma fiable. */
  permalink: string | null;
  publishedAt: string;
  /** Fragmento crudo de la respuesta, para auditoría. Nunca contiene credenciales. */
  raw?: unknown;
}

export interface SocialProvider<N extends NetworkId = NetworkId> {
  readonly id: N;

  readonly capabilities: {
    /** Límite de caracteres. En X es longitud ponderada (aproximada aquí). */
    maxTextLength: number;
  };

  /** Publica el texto. Debe lanzar `PublishError` (ver ./errors) ante cualquier fallo. */
  publishText(input: PublishInput<N>): Promise<PublishResult>;
}
