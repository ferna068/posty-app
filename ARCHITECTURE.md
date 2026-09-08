# Posty — Architecture Specification

> **Estado:** v1.0 (baseline arquitectónico)
> **Autor:** Principal Software Architect
> **Stack:** Next.js (App Router) · TypeScript (strict) · PostgreSQL · Prisma · KMS
> **Alcance:** publicación multi-red (X / Twitter API v2, LinkedIn API, Meta Graph API — Facebook Pages)

---

## 0. Índice

1. [Principios y decisiones de arquitectura](#1-principios-y-decisiones-de-arquitectura)
2. [Estrategia de autenticación OAuth 2.0](#2-estrategia-de-autenticación-oauth-20)
3. [Esquema de datos y custodia de tokens](#3-esquema-de-datos-y-custodia-de-tokens)
4. [Contrato del endpoint `POST /api/v1/posts/publish`](#4-contrato-del-endpoint-post-apiv1postspublish)
5. [Modelo de errores](#5-modelo-de-errores)
6. [Estructura de carpetas](#6-estructura-de-carpetas)
7. [Operación: rate limits, observabilidad, seguridad](#7-operación-rate-limits-observabilidad-seguridad)
8. [Riesgos abiertos y roadmap](#8-riesgos-abiertos-y-roadmap)

---

## 1. Principios y decisiones de arquitectura

### 1.1 Decisiones (ADR resumidos)

| # | Decisión | Motivo | Alternativa descartada |
|---|---|---|---|
| ADR-01 | **Un solo `Provider Adapter` por red social**, detrás de una interfaz común `SocialProvider` | Cada API (X, LinkedIn, Meta) difiere en OAuth, refresh, formato de payload, límites y errores. Aislar la diferencia en el borde evita `if (network === 'twitter')` regado por el dominio | Cliente HTTP genérico con `switch` |
| ADR-02 | **El endpoint de publicación es asíncrono** (`202 Accepted` + `publicationId`) | Fan-out a N APIs externas con latencias de 300 ms–8 s y fallos parciales; los timeouts de función serverless (10–60 s) no son un lugar donde esperar a terceros. Permite reintentos con backoff sin re-ejecutar publicaciones ya exitosas | Request síncrono que espera a los 3 proveedores |
| ADR-03 | **Fallo parcial es un resultado de primera clase**, no un error | Publicar en 3 redes y que LinkedIn falle no invalida las otras 2. El estado vive por *target*, no por publicación | Transacción todo-o-nada (imposible: no hay 2PC sobre APIs de terceros) |
| ADR-04 | **Tokens cifrados con envelope encryption (AES-256-GCM + KMS)**, nunca en texto plano ni accesibles desde el cliente | Un token de LinkedIn/Meta es una credencial de larga vida sobre la identidad del usuario. Un dump de la BD no debe ser suficiente para publicar en nombre de nadie | Cifrado simétrico con clave en variable de entorno |
| ADR-05 | **Idempotencia obligatoria** vía `Idempotency-Key` | Los reintentos de red del cliente no pueden producir tweets duplicados. Duplicar un post es un error visible para el usuario final y no revertible | Deduplicación por hash de contenido |
| ADR-06 | **Toda la superficie de red social es server-only** (Route Handlers + Server Actions) | Los `client components` jamás deben ver un token. `import 'server-only'` en la capa `lib/providers/**` como barrera de compilación | Llamadas desde el navegador con token de corta vida |
| ADR-07 | **Versionado en la ruta (`/api/v1/...`)** | Los contratos de publicación cambiarán (multimedia, hilos, programación). La URL versionada es el mecanismo más barato de convivencia | Versionado por header |

### 1.2 Diagrama de componentes

```
                        ┌───────────────────────────────────┐
   Browser / Client ───▶ │  Next.js App Router (Vercel/Node) │
                        ├───────────────────────────────────┤
                        │  app/(app)/**        UI (RSC)     │
                        │  app/api/v1/**       Route Handlers│
                        │  app/api/auth/**     OAuth callbacks│
                        └──────┬──────────────────┬─────────┘
                               │                  │
                 ┌─────────────▼────────┐   ┌─────▼──────────────────┐
                 │  Application Layer   │   │  TokenVault             │
                 │  PublishService      │◀──│  get/refresh/rotate     │
                 │  ConnectionService   │   │  (envelope encryption)  │
                 └─────────────┬────────┘   └─────┬──────────────────┘
                               │                  │
                 ┌─────────────▼──────────────────▼───────────┐
                 │  Provider Adapters (SocialProvider)         │
                 │  ┌──────────┐ ┌───────────┐ ┌────────────┐ │
                 │  │ X (v2)   │ │ LinkedIn  │ │ Meta Graph │ │
                 │  └──────────┘ └───────────┘ └────────────┘ │
                 └─────────────┬──────────────────┬───────────┘
                               │                  │
                    ┌──────────▼───────┐   ┌──────▼──────────┐
                    │  PostgreSQL      │   │  Cloud KMS      │
                    │  (Prisma)        │   │  (CMK, no export)│
                    └──────────────────┘   └─────────────────┘
                               ▲
                    ┌──────────┴───────┐
                    │  Queue + Worker  │  (QStash / SQS / pg-boss)
                    │  publish.target  │
                    └──────────────────┘
```

### 1.3 La interfaz que todo proveedor implementa

```ts
// lib/providers/types.ts
import 'server-only';

export type NetworkId = 'twitter' | 'linkedin' | 'facebook';

export interface AuthorizationRequest {
  url: string;            // URL de autorización a la que se redirige al usuario
  state: string;          // CSRF, persistido server-side
  codeVerifier?: string;  // PKCE (X exige S256)
}

export interface ProviderTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;       // null/undefined => token sin expiración conocida (Page Token de Meta)
  scopes: string[];
  externalAccountId: string;
  externalAccountName: string;
  externalAccountHandle?: string;
  avatarUrl?: string;
  meta?: Record<string, unknown>;
}

export interface PublishInput {
  text: string;
  connection: ResolvedConnection;   // incluye accessToken ya descifrado y vigente
  idempotencyKey: string;
}

export interface PublishResult {
  externalPostId: string;
  permalink: string | null;
  publishedAt: Date;
  raw?: unknown;                    // respuesta cruda, truncada, para auditoría
}

export interface SocialProvider {
  readonly id: NetworkId;

  /** Límites y capacidades declarativas: el dominio valida contra esto, no con constantes sueltas. */
  readonly capabilities: {
    maxTextLength: number;
    supportsMedia: boolean;
    supportsScheduling: boolean;
    requiresRefreshBeforeExpiry: boolean;
  };

  buildAuthorizationRequest(input: { redirectUri: string }): Promise<AuthorizationRequest>;
  exchangeCodeForTokens(input: {
    code: string; redirectUri: string; codeVerifier?: string;
  }): Promise<ProviderTokenSet>;

  /** Puede lanzar ProviderReauthRequiredError si el refresh ya no es posible. */
  refreshTokens(input: { refreshToken: string }): Promise<ProviderTokenSet>;

  revoke(input: { accessToken: string; refreshToken?: string }): Promise<void>;

  publishText(input: PublishInput): Promise<PublishResult>;

  /** Traduce el error HTTP del proveedor al modelo de errores de Posty (§5). */
  normalizeError(error: unknown): PostyProviderError;
}
```

**Regla de oro:** ninguna capa por encima de `lib/providers/**` conoce URLs, headers, scopes ni códigos de error de terceros.

---

## 2. Estrategia de autenticación OAuth 2.0

### 2.1 Dos planos de identidad, deliberadamente separados

| Plano | Qué es | Dónde vive |
|---|---|---|
| **Identidad de Posty** | Login del usuario en la app (email+password / passkey / social login) | `User` + sesión (Auth.js / cookie firmada, `httpOnly`, `SameSite=Lax`, `Secure`) |
| **Conexiones sociales** | Autorizaciones OAuth 2.0 delegadas para publicar en nombre del usuario | `SocialConnection` + `SocialToken` |

> **Anti-patrón evitado:** usar "Login with Twitter/LinkedIn/Facebook" también como mecanismo de conexión para publicar. Si el usuario revoca el permiso de publicación, no debe perder el acceso a su cuenta de Posty; y si cambia de contraseña en Meta, la sesión de Posty debe sobrevivir. Son ciclos de vida distintos y se modelan por separado.

### 2.2 Flujo común (Authorization Code)

```
1. GET  /api/auth/{network}/connect
        → genera state (256 bits) + PKCE verifier (X), los guarda en tabla OAuthState
          (TTL 10 min, ligado a userId) y redirige al Authorization Server.

2. Usuario consiente en el proveedor.

3. GET  /api/auth/{network}/callback?code=...&state=...
        → valida state (existe, no expirado, no consumido, mismo userId)
        → intercambia code por tokens (server-to-server, client_secret desde env/KMS)
        → obtiene identidad de la cuenta externa (/me, /2/users/me, /me/accounts)
        → upsert SocialConnection + cifra y guarda SocialToken
        → marca OAuthState como consumido (single-use)
        → redirige a /settings/connections?connected={network}
```

**Invariantes de seguridad del flujo:**

- `state` es **single-use**, opaco, generado con `crypto.randomBytes(32)`, y almacenado server-side. No se acepta `state` en cookie exclusivamente (evita fijación en navegadores con cookies particionadas).
- `redirect_uri` es **exacta y fija** por entorno, registrada en cada consola de desarrollador. Nunca se construye desde `Host`/`X-Forwarded-Host` del request (previene *redirect_uri* injection).
- El `code` se intercambia **una sola vez**; un segundo callback con el mismo `state` devuelve `409` y se audita como posible replay.
- Los `client_secret` viven en el gestor de secretos (Vercel Encrypted Env / AWS Secrets Manager). Nunca en `NEXT_PUBLIC_*`.
- Todos los callbacks corren en **Node.js runtime** (`export const runtime = 'nodejs'`), no en Edge: requieren `crypto` completo y acceso a KMS.

### 2.3 X — Twitter API v2

| Aspecto | Valor |
|---|---|
| Flujo | **Authorization Code Flow with PKCE (S256)** — obligatorio |
| Authorize | `https://twitter.com/i/oauth2/authorize` |
| Token | `https://api.twitter.com/2/oauth2/token` |
| Autenticación en token endpoint | `Basic` con `client_id:client_secret` (apps confidenciales) |
| Scopes | `tweet.read`, `tweet.write`, `users.read`, **`offline.access`** |
| Publicación | `POST https://api.twitter.com/2/tweets` → `{ "text": "..." }` |
| Vida del access token | ~2 horas |
| Refresh token | Sí, **rotativo y de un solo uso**: cada refresh devuelve un `refresh_token` nuevo y **invalida el anterior** |
| Límite de texto | 280 caracteres (peso ponderado: URLs cuentan como 23, CJK cuenta doble) |

```ts
// lib/providers/twitter/oauth.ts (esencia)
const authorizeUrl = new URL('https://twitter.com/i/oauth2/authorize');
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('client_id', env.TWITTER_CLIENT_ID);
authorizeUrl.searchParams.set('redirect_uri', redirectUri);
authorizeUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
authorizeUrl.searchParams.set('state', state);
authorizeUrl.searchParams.set('code_challenge', base64UrlSha256(codeVerifier));
authorizeUrl.searchParams.set('code_challenge_method', 'S256');
```

> ⚠️ **El punto crítico de X: la rotación del refresh token.**
> Si dos procesos refrescan en paralelo, el segundo recibe `400 invalid_request` y la conexión queda **muerta** (ambos refresh tokens inválidos → re-autorización manual del usuario).
>
> **Mitigación obligatoria:** el refresh se ejecuta bajo un **lock pesimista por conexión**:
>
> ```sql
> SELECT * FROM social_tokens WHERE connection_id = $1 FOR UPDATE;
> ```
>
> dentro de una transacción, con `SELECT ... FOR UPDATE NOWAIT` + reintento corto (100 ms, hasta 3 veces) para el proceso perdedor, que al re-leer encontrará el token ya renovado. Ver §3.5.

**Cómputo de longitud:** X no cuenta code points crudos. `capabilities.maxTextLength = 280` se valida con un `weightedLength()` que aplica los rangos de peso de `twitter-text` (rangos por defecto peso 2, ASCII/Latin-1 peso 1, URLs = 23). Se implementa en `lib/providers/twitter/text.ts` y se testea contra los vectores oficiales de `twitter-text`.

### 2.4 LinkedIn

| Aspecto | Valor |
|---|---|
| Flujo | Authorization Code (3-legged). PKCE no requerido, se envía igualmente si el producto lo soporta |
| Authorize | `https://www.linkedin.com/oauth/v2/authorization` |
| Token | `https://www.linkedin.com/oauth/v2/accessToken` |
| Scopes | `openid`, `profile`, **`w_member_social`** (productos: *Sign In with LinkedIn using OpenID Connect* + *Share on LinkedIn*) |
| Identidad | `GET https://api.linkedin.com/v2/userinfo` → `sub` = ID del miembro |
| Publicación | `POST https://api.linkedin.com/rest/posts` |
| Headers obligatorios | `LinkedIn-Version: AAAAMM` (p.ej. `202409`), `X-Restli-Protocol-Version: 2.0.0` |
| Vida del access token | **60 días** |
| Refresh token | **Solo para aplicaciones aprobadas** por LinkedIn. Vida del refresh: 365 días |
| Límite de texto | 3.000 caracteres |

```jsonc
// POST https://api.linkedin.com/rest/posts
{
  "author": "urn:li:person:{sub}",
  "commentary": "texto del post",
  "visibility": "PUBLIC",
  "distribution": {
    "feedDistribution": "MAIN_FEED",
    "targetEntities": [],
    "thirdPartyDistributionChannels": []
  },
  "lifecycleState": "PUBLISHED",
  "isReshareDisabledByAuthor": false
}
// → 201 Created, header `x-restli-id: urn:li:share:7231...`
```

> ⚠️ **El punto crítico de LinkedIn: puede no haber refresh token.**
> El adaptador **no asume** su existencia. Si `refreshToken` es `null`, la conexión se trata como **de vida finita**: `expiresAt` a 60 días, y el sistema entra en modo *notificación proactiva* (§3.6): a los 53 días se emite `connection.expiring` y se pide al usuario reconectar. Si el token caduca, el target falla con `REAUTH_REQUIRED` y la publicación **no se reintenta**.

**Escapado de caracteres:** el campo `commentary` usa "Little Text Format": los caracteres `( ) [ ] { } < > @ | ~ _ * #` deben ir escapados con `\`. Esto vive en `lib/providers/linkedin/text.ts` y es responsabilidad exclusiva del adaptador — el texto entra al sistema en crudo y solo se transforma en el borde.

### 2.5 Meta Graph API — Facebook Pages

Es el flujo con más aristas: **el token que publica no es el token que se obtiene del login.**

```
Short-lived User Token (~1 h)
        │  GET /oauth/access_token?grant_type=fb_exchange_token
        ▼
Long-lived User Token (~60 días)
        │  GET /me/accounts   (con el long-lived user token)
        ▼
Page Access Token  ── sin expiración declarada mientras el user token de origen siga vivo
```

| Aspecto | Valor |
|---|---|
| Flujo | Authorization Code (Facebook Login) |
| Authorize | `https://www.facebook.com/v21.0/dialog/oauth` |
| Token | `https://graph.facebook.com/v21.0/oauth/access_token` |
| Scopes | `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `business_management` |
| Publicación | `POST https://graph.facebook.com/v21.0/{page-id}/feed` → `{ message, access_token }` |
| Token de publicación | **Page Access Token**, no el User Token |
| Límite de texto | 63.206 caracteres |
| Verificación de integridad | `appsecret_proof` = `HMAC-SHA256(access_token, app_secret)` en cada llamada |

**Consecuencias de modelado:**

1. **Una conexión = una Página**, no una cuenta de Facebook. Un usuario con 4 Páginas produce 4 filas en `SocialConnection`. La UI de conexión incluye un paso de **selección de Página** tras el callback.
2. Se persisten **ambos** tokens: el `long-lived user token` (con `expiresAt` a 60 días, necesario para re-derivar Page Tokens) y el `page access token` (el que publica).
3. **No existe `refresh_token`.** La "renovación" es un re-intercambio del long-lived user token contra sí mismo antes de los 60 días. El `TokenVault` implementa esto como `refreshTokens()` para respetar la interfaz, aunque internamente sea un `fb_exchange_token`.
4. El Page Token se **invalida** si el usuario cambia su contraseña de Facebook, revoca permisos, o pierde el rol en la Página. Se detecta por el subcódigo de error de Meta (§5.3) → `REAUTH_REQUIRED` inmediato, sin reintentos.
5. **`appsecret_proof` es obligatorio** en producción (se activa "Require App Secret" en la consola). Esto anula el valor de un token robado sin el `app_secret`.

```ts
// lib/providers/meta/client.ts
const appsecretProof = createHmac('sha256', env.META_APP_SECRET)
  .update(accessToken)
  .digest('hex');
```

> **App Review:** `pages_manage_posts` requiere *Advanced Access* aprobado por Meta antes de operar con cuentas fuera del equipo de desarrollo. Es una dependencia de calendario de lanzamiento, no técnica. Idem para X (nivel de acceso ≥ Basic) y LinkedIn (producto *Share on LinkedIn* aprobado).

### 2.6 Matriz comparativa (la razón de ADR-01)

| | X (v2) | LinkedIn | Meta (Pages) |
|---|---|---|---|
| PKCE | **Obligatorio** | Opcional | No |
| Access token TTL | ~2 h | 60 días | ~60 días (user) / sin expiración (page) |
| Refresh token | Sí, **rotativo** | Solo apps aprobadas | **No existe** |
| Estrategia de renovación | Refresh + lock | Refresh o reconexión | Re-exchange del long-lived |
| Entidad que publica | Usuario | Miembro (`urn:li:person`) | **Página** |
| Firma extra por request | — | Headers de versión | **`appsecret_proof`** |
| Límite de texto | 280 (ponderado) | 3.000 | 63.206 |
| Idempotencia nativa | No | No | No |

---

## 3. Esquema de datos y custodia de tokens

### 3.1 Modelo de amenaza (qué protegemos y de qué)

| Amenaza | Control |
|---|---|
| Dump de la base de datos (backup filtrado, réplica mal configurada, SQL injection) | Tokens cifrados con DEK; la DEK está cifrada por una CMK en KMS que **no sale del HSM**. El dump es criptográficamente inútil sin permisos IAM sobre la CMK |
| Insider con acceso `SELECT` a producción | Idem + `SocialToken` en tabla separada con permisos de rol distintos; ningún token se loguea |
| Sustitución de ciphertext entre filas (atacante copia el token cifrado de la víctima a su propia conexión) | **AAD (Additional Authenticated Data)** = `connectionId ‖ provider ‖ tokenType`. El descifrado falla si el ciphertext se mueve de fila |
| Fuga vía logs / telemetría / mensajes de error | `redactor` global en el logger + tipo `Secret<string>` cuyo `toString()`/`toJSON()` devuelve `"[redacted]"` |
| Exposición al cliente | `import 'server-only'` en `lib/vault/**` y `lib/providers/**`; ningún DTO de API contiene campos de token |
| Compromiso de una clave | `keyVersion` por registro → rotación de CMK sin re-cifrado masivo; re-cifrado perezoso en cada lectura |

### 3.2 Envelope encryption — diseño

```
                    ┌────────────────────────────────┐
                    │  Cloud KMS  ─  CMK "posty/tokens"│  ← no exportable, rotación anual
                    └───────────────┬────────────────┘
                                    │ Decrypt(encryptedDek)
                                    ▼
   ciphertext ── AES-256-GCM ── DEK (32 bytes, en memoria, TTL 5 min en caché LRU)
        ▲
        │  AAD = `${connectionId}:${provider}:${tokenType}`
        │  IV  = 12 bytes aleatorios por operación (nunca reutilizado)
        │  Tag = 16 bytes
```

Formato serializado en columna `bytea` (o `text` base64):

```
v1.{keyVersion}.{base64(iv)}.{base64(authTag)}.{base64(ciphertext)}
```

El prefijo `v1` permite migrar de algoritmo sin ambigüedad. `keyVersion` identifica la CMK/DEK usada.

```ts
// lib/vault/crypto.ts
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export function seal(plaintext: string, dek: Buffer, aad: string, keyVersion: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, dek, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', keyVersion, b64(iv), b64(tag), b64(ct)].join('.');
}

export function open(envelope: string, dek: Buffer, aad: string): string {
  const [version, , iv, tag, ct] = envelope.split('.');
  if (version !== 'v1') throw new UnsupportedEnvelopeError(version);
  const decipher = createDecipheriv(ALGO, dek, unb64(iv), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(unb64(tag));
  return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString('utf8');
}
```

> **Nota de implementación:** si el despliegue es sobre Supabase/Neon sin KMS gestionada, la alternativa aceptable es una **master key de 32 bytes en el gestor de secretos**, con el mismo formato de sobre y `keyVersion`. Es un downgrade consciente en el modelo de amenaza (la clave sí es exportable por quien tenga acceso al entorno) y debe documentarse como deuda de seguridad, no como equivalente.

### 3.3 Esquema Prisma

```prisma
// prisma/schema.prisma
generator client { provider = "prisma-client-js" }
datasource db    { provider = "postgresql"; url = env("DATABASE_URL") }

enum Network {
  TWITTER
  LINKEDIN
  FACEBOOK
}

enum ConnectionStatus {
  ACTIVE            // token vigente o renovable
  EXPIRING          // caduca en < 7 días y no hay refresh token
  REAUTH_REQUIRED   // el proveedor rechazó las credenciales; requiere acción del usuario
  REVOKED           // desconectada por el usuario
}

enum TokenType {
  ACCESS
  REFRESH
  LONG_LIVED_USER   // Meta: token de usuario de 60 días usado para re-derivar page tokens
}

enum PublicationStatus {
  QUEUED
  PROCESSING
  COMPLETED         // todos los targets PUBLISHED
  PARTIAL           // al menos uno PUBLISHED y al menos uno FAILED
  FAILED            // ningún target PUBLISHED
}

enum TargetStatus {
  PENDING
  PROCESSING
  PUBLISHED
  FAILED
  SKIPPED           // conexión inválida antes de intentar
}

// ────────────────────────────── Identidad de Posty ──────────────────────────────

model User {
  id            String   @id @default(cuid())
  email         String   @unique
  name          String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  connections   SocialConnection[]
  publications  Publication[]

  @@map("users")
}

// ─────────────────────────── Conexiones sociales ────────────────────────────────

model SocialConnection {
  id        String  @id @default(cuid())
  userId    String
  network   Network

  /// ID de la cuenta/página en el proveedor.
  /// X: user id · LinkedIn: `sub` del userinfo · Meta: page id
  externalAccountId     String
  externalAccountName   String
  externalAccountHandle String?
  avatarUrl             String?

  /// Meta: id de usuario dueño de la página; permite re-derivar page tokens.
  externalOwnerId       String?

  scopes    String[]
  status    ConnectionStatus @default(ACTIVE)

  /// Diagnóstico de la última renovación/publicación fallida (sin secretos).
  lastError     String?
  lastErrorAt   DateTime?
  lastUsedAt    DateTime?
  connectedAt   DateTime @default(now())
  updatedAt     DateTime @updatedAt

  user      User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokens    SocialToken[]
  targets   PublicationTarget[]

  /// Una sola conexión activa por (usuario, red, cuenta externa).
  @@unique([userId, network, externalAccountId])
  @@index([status, network])
  @@map("social_connections")
}

/// Tabla aislada: permisos de BD más estrictos, jamás en un `include` por defecto.
model SocialToken {
  id           String    @id @default(cuid())
  connectionId String
  type         TokenType

  /// Sobre `v1.{keyVersion}.{iv}.{tag}.{ciphertext}` — AES-256-GCM.
  /// AAD = `${connectionId}:${network}:${type}` (previene sustitución entre filas).
  ciphertext   String    @db.Text
  keyVersion   String

  /// Momento de expiración declarado por el proveedor. NULL = sin expiración conocida
  /// (Page Access Token de Meta). NUNCA se asume "no expira" por ausencia del dato.
  expiresAt    DateTime?

  /// Contadores para detectar rotaciones anómalas (X invalida el refresh anterior).
  rotationCount Int      @default(0)
  lastRotatedAt DateTime?

  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  connection   SocialConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)

  @@unique([connectionId, type])
  @@index([expiresAt])
  @@map("social_tokens")
}

/// State + PKCE verifier del flujo OAuth. Single-use, TTL corto.
model OAuthState {
  id           String   @id @default(cuid())
  state        String   @unique
  userId       String
  network      Network
  /// El code_verifier es sensible mientras el flujo está abierto: se cifra igual que un token.
  codeVerifier String?  @db.Text
  redirectUri  String
  returnTo     String?
  consumedAt   DateTime?
  expiresAt    DateTime
  createdAt    DateTime @default(now())

  @@index([expiresAt])
  @@map("oauth_states")
}

// ─────────────────────────────── Publicaciones ──────────────────────────────────

model Publication {
  id             String  @id @default(cuid())
  userId         String

  /// Contenido canónico, sin transformar. Cada adaptador aplica su propio formateo.
  text           String  @db.Text

  status         PublicationStatus @default(QUEUED)

  /// Clave del header `Idempotency-Key`, ámbito por usuario.
  idempotencyKey String

  /// Hash del cuerpo de la petición: detecta reuso de la misma clave con distinto payload → 422.
  requestHash    String

  scheduledAt    DateTime?
  completedAt    DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  user    User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  targets PublicationTarget[]

  @@unique([userId, idempotencyKey])
  @@index([userId, createdAt(sort: Desc)])
  @@index([status])
  @@map("publications")
}

model PublicationTarget {
  id            String  @id @default(cuid())
  publicationId String
  connectionId  String
  network       Network

  status        TargetStatus @default(PENDING)

  externalPostId String?
  permalink      String?
  publishedAt    DateTime?

  /// Error normalizado (§5). Nunca contiene tokens ni PII del proveedor.
  errorCode      String?
  errorMessage   String?
  providerStatus Int?

  attempts       Int      @default(0)
  nextAttemptAt  DateTime?

  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  publication  Publication      @relation(fields: [publicationId], references: [id], onDelete: Cascade)
  connection   SocialConnection @relation(fields: [connectionId], references: [id], onDelete: Restrict)

  /// Una publicación no puede tener dos targets a la misma conexión.
  @@unique([publicationId, connectionId])
  @@index([status, nextAttemptAt])
  @@map("publication_targets")
}

/// Bitácora inmutable de eventos sensibles (conexión, revocación, refresh, publicación).
model AuditLog {
  id         String   @id @default(cuid())
  userId     String?
  action     String   // 'connection.created' | 'token.refreshed' | 'publish.succeeded' | ...
  network    Network?
  resourceId String?
  ip         String?
  userAgent  String?
  metadata   Json?    // sin secretos, validado por un allowlist de claves
  createdAt  DateTime @default(now())

  @@index([userId, createdAt(sort: Desc)])
  @@map("audit_logs")
}
```

### 3.4 Por qué `SocialToken` es una tabla aparte

1. **Superficie de exposición mínima:** `prisma.socialConnection.findMany()` — la consulta que alimenta la UI — no puede filtrar un token por accidente. Hay que pedirlo explícitamente.
2. **Permisos diferenciados:** el rol de BD de la app de lectura (analytics, dashboards) recibe `GRANT SELECT` sobre `social_connections` y **ninguno** sobre `social_tokens`.
3. **Ciclo de vida distinto:** un token rota decenas de veces (X: cada 2 h); la conexión es estable. Separarlos evita reescrituras de la fila "ancha" y mantiene el `updatedAt` de la conexión como señal real.
4. **Multiplicidad:** Meta necesita 2 tokens vivos por conexión (`ACCESS` = page token, `LONG_LIVED_USER`). El modelo `1..N` lo soporta sin columnas opcionales acumuladas.

### 3.5 `TokenVault` — el único punto de acceso a credenciales

```ts
// lib/vault/token-vault.ts
import 'server-only';

/** Margen de seguridad: se refresca antes de la expiración real. */
const REFRESH_SKEW_SECONDS = 300;

export interface ResolvedConnection {
  connectionId: string;
  network: NetworkId;
  externalAccountId: string;
  accessToken: string;   // descifrado, vigente, en memoria — jamás persistido ni logueado
  meta: Record<string, unknown>;
}

/**
 * Devuelve un access token vigente para la conexión.
 * Refresca de forma transparente bajo lock pesimista.
 * Lanza ReauthRequiredError si la conexión ya no es recuperable.
 */
export async function resolveConnection(connectionId: string): Promise<ResolvedConnection>;
```

**Algoritmo de `resolveConnection`:**

```
1. Leer SocialConnection + SocialToken(ACCESS).
2. Si status ∈ {REVOKED, REAUTH_REQUIRED} → ReauthRequiredError (sin tocar el proveedor).
3. Si expiresAt es NULL o (expiresAt - now) > 300 s → descifrar y devolver.
4. Necesita refresh:
   4.1. BEGIN;
   4.2. SELECT ... FROM social_tokens WHERE connection_id = $1 FOR UPDATE;   ← serializa
   4.3. Re-evaluar expiración (otro proceso pudo refrescar mientras esperábamos el lock).
        Si ya está vigente → COMMIT y devolver el nuevo.
   4.4. provider.refreshTokens({ refreshToken })
        - X:        POST /2/oauth2/token grant_type=refresh_token  → tokens rotados
        - LinkedIn: idem, si la app tiene refresh habilitado; si no → ReauthRequiredError
        - Meta:     GET /oauth/access_token?grant_type=fb_exchange_token
   4.5. Escribir ACCESS (+ REFRESH si rotó), rotationCount++, lastRotatedAt = now.
   4.6. COMMIT;
5. Si el refresh devuelve invalid_grant / OAuthException(190) →
   connection.status = REAUTH_REQUIRED, borrar tokens, emitir evento `connection.reauth_required`,
   lanzar ReauthRequiredError.
```

> El lock pesimista (`FOR UPDATE`) es **no negociable en X**: la rotación de refresh tokens convierte una carrera benigna en pérdida permanente de la conexión. En un despliegue multi-región con réplicas, el lock debe tomarse contra el primario.

### 3.6 Ciclo de vida de una conexión

```
        connect (OAuth)
             │
             ▼
      ┌──────────────┐  refresh ok        ┌──────────────┐
      │   ACTIVE     │◀──────────────────▶│   ACTIVE     │
      └──────┬───────┘                     └──────────────┘
             │ expiresAt - now < 7d  y  sin refresh_token
             ▼
      ┌──────────────┐  usuario reconecta
      │  EXPIRING    │──────────────────▶ ACTIVE
      └──────┬───────┘  (email + banner en la UI)
             │ token expirado o invalid_grant / OAuthException 190
             ▼
      ┌──────────────────┐  usuario reconecta
      │ REAUTH_REQUIRED  │──────────────▶ ACTIVE
      └──────┬───────────┘
             │ usuario desconecta (revoke en el proveedor + borrado local de tokens)
             ▼
      ┌──────────────┐
      │   REVOKED    │  (fila conservada para auditoría; tokens eliminados)
      └──────────────┘
```

Un cron diario (`/api/cron/token-maintenance`, protegido por `CRON_SECRET`) recorre `social_tokens` con `expiresAt < now + 7d`, refresca de forma proactiva lo que puede refrescarse y marca `EXPIRING` + notifica lo que no.

---

## 4. Contrato del endpoint `POST /api/v1/posts/publish`

### 4.1 Resumen

| | |
|---|---|
| **Método y ruta** | `POST /api/v1/posts/publish` |
| **Autenticación** | Sesión de Posty (cookie `httpOnly`) **o** `Authorization: Bearer <api_key>` |
| **Content-Type** | `application/json; charset=utf-8` |
| **Headers requeridos** | `Idempotency-Key: <uuid-v4>` |
| **Respuesta feliz** | `202 Accepted` con el recurso `Publication` en estado `queued` |
| **Semántica** | Fan-out asíncrono; **fallo parcial es un resultado válido**, no un error HTTP |
| **Runtime** | `nodejs` (acceso a KMS y `crypto`) |

> **Por qué `202` y no `200`:** el endpoint acepta la intención de publicar; no puede garantizar sincrónicamente el resultado en tres APIs de terceros dentro del presupuesto de latencia de una request HTTP. El cliente obtiene el resultado final por *polling* de `GET /api/v1/posts/{id}` o por webhook. **El contrato no cambia** si en el MVP el worker se ejecuta en el mismo proceso (`after()` / `waitUntil()`) en lugar de en una cola: eso es una decisión de despliegue, no de API.

### 4.2 Request

```http
POST /api/v1/posts/publish HTTP/1.1
Host: posty.app
Content-Type: application/json
Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7
Authorization: Bearer psty_live_ak_9f3c...

{
  "text": "Acabamos de lanzar Posty: publica en X, LinkedIn y Facebook desde un solo sitio.",
  "networks": ["twitter", "linkedin", "facebook"],
  "options": {
    "connectionIds": { "facebook": "cln_8sd7f6g5h4j3k2" },
    "scheduledAt": null,
    "validateOnly": false,
    "allowPartialSuccess": true
  }
}
```

#### Esquema (Zod — fuente única de verdad, tipos derivados)

```ts
// lib/api/v1/schemas/publish.ts
import { z } from 'zod';

export const NetworkIdSchema = z.enum(['twitter', 'linkedin', 'facebook']);

export const PublishRequestSchema = z.object({
  /** Contenido canónico. Se valida contra el límite de CADA red destino (§4.4). */
  text: z
    .string()
    .trim()
    .min(1, 'text must not be empty')
    .max(63206, 'text exceeds the maximum supported by any network'),

  /** Redes destino. Sin duplicados, al menos una. */
  networks: z
    .array(NetworkIdSchema)
    .min(1, 'at least one network is required')
    .max(3)
    .refine((n) => new Set(n).size === n.length, 'networks must not contain duplicates'),

  options: z
    .object({
      /**
       * Desambigua cuando el usuario tiene varias conexiones en una misma red
       * (caso típico: varias Páginas de Facebook). Si se omite y hay exactamente
       * una conexión activa, se usa esa; si hay varias → 409 AMBIGUOUS_CONNECTION.
       */
      connectionIds: z.record(NetworkIdSchema, z.string().cuid2()).optional(),

      /** ISO 8601 con offset. Debe ser > now + 5 min y < now + 90 días. */
      scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),

      /** Valida y resuelve conexiones sin publicar nada. Devuelve 200, no 202. */
      validateOnly: z.boolean().default(false),

      /**
       * true  (por defecto): publica en las redes válidas aunque otras fallen la validación.
       * false: si alguna red destino no es publicable, no se publica en ninguna → 422.
       */
      allowPartialSuccess: z.boolean().default(true),
    })
    .default({}),
});

export type PublishRequest = z.infer<typeof PublishRequestSchema>;
```

#### Campos

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `text` | `string` | ✅ | Texto del post. 1–63206 caracteres. Validado además contra el límite de cada red destino |
| `networks` | `("twitter"\|"linkedin"\|"facebook")[]` | ✅ | Redes destino. 1–3 elementos, sin duplicados |
| `options.connectionIds` | `Record<network, string>` | ❌ | Conexión concreta por red. Obligatorio si hay >1 conexión activa en esa red |
| `options.scheduledAt` | `string \| null` (ISO 8601) | ❌ | Publicación programada. `null`/omitido = inmediata |
| `options.validateOnly` | `boolean` | ❌ | Dry-run. Default `false` |
| `options.allowPartialSuccess` | `boolean` | ❌ | Default `true`. Ver §4.4 |

### 4.3 Response `202 Accepted`

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
Location: /api/v1/posts/pub_01HQ8Z3K7V2N5M4P
X-Request-Id: req_01HQ8Z3K7V2N5M4Q
```

```json
{
  "data": {
    "id": "pub_01HQ8Z3K7V2N5M4P",
    "status": "queued",
    "text": "Acabamos de lanzar Posty: publica en X, LinkedIn y Facebook desde un solo sitio.",
    "scheduledAt": null,
    "createdAt": "2026-09-07T18:42:11.204Z",
    "completedAt": null,
    "targets": [
      {
        "network": "twitter",
        "connectionId": "cln_2h4j6k8m0n2p4r6t",
        "accountName": "@posty_app",
        "status": "pending",
        "externalPostId": null,
        "permalink": null,
        "publishedAt": null,
        "error": null
      },
      {
        "network": "linkedin",
        "connectionId": "cln_9z8y7x6w5v4u3t2s",
        "accountName": "Emanuel Fernández",
        "status": "pending",
        "externalPostId": null,
        "permalink": null,
        "publishedAt": null,
        "error": null
      },
      {
        "network": "facebook",
        "connectionId": "cln_8sd7f6g5h4j3k2",
        "accountName": "Posty HQ",
        "status": "pending",
        "externalPostId": null,
        "permalink": null,
        "publishedAt": null,
        "error": null
      }
    ]
  },
  "meta": {
    "requestId": "req_01HQ8Z3K7V2N5M4Q",
    "pollUrl": "/api/v1/posts/pub_01HQ8Z3K7V2N5M4P"
  }
}
```

#### Estado terminal (vía `GET /api/v1/posts/{id}`) — ejemplo con fallo parcial

```json
{
  "data": {
    "id": "pub_01HQ8Z3K7V2N5M4P",
    "status": "partial",
    "completedAt": "2026-09-07T18:42:14.881Z",
    "targets": [
      {
        "network": "twitter",
        "connectionId": "cln_2h4j6k8m0n2p4r6t",
        "accountName": "@posty_app",
        "status": "published",
        "externalPostId": "1832994210022338560",
        "permalink": "https://x.com/posty_app/status/1832994210022338560",
        "publishedAt": "2026-09-07T18:42:12.410Z",
        "error": null
      },
      {
        "network": "linkedin",
        "connectionId": "cln_9z8y7x6w5v4u3t2s",
        "accountName": "Emanuel Fernández",
        "status": "published",
        "externalPostId": "urn:li:share:7231884019922330112",
        "permalink": "https://www.linkedin.com/feed/update/urn:li:share:7231884019922330112",
        "publishedAt": "2026-09-07T18:42:13.902Z",
        "error": null
      },
      {
        "network": "facebook",
        "connectionId": "cln_8sd7f6g5h4j3k2",
        "accountName": "Posty HQ",
        "status": "failed",
        "externalPostId": null,
        "permalink": null,
        "publishedAt": null,
        "error": {
          "code": "REAUTH_REQUIRED",
          "message": "La conexión con Facebook ha expirado. Vuelve a conectar la Página para publicar.",
          "retryable": false,
          "providerStatus": 400,
          "reconnectUrl": "/api/auth/facebook/connect?connectionId=cln_8sd7f6g5h4j3k2"
        }
      }
    ]
  }
}
```

**Máquina de estados de `Publication.status`:**

```
queued ──▶ processing ──┬──▶ completed   (todos los targets published)
                        ├──▶ partial     (≥1 published ∧ ≥1 failed)
                        └──▶ failed      (ningún target published)
```

`TargetStatus`: `pending → processing → published | failed | skipped`

### 4.4 Reglas de validación (orden de evaluación)

El handler valida en este orden y **corta en el primer fallo estructural**:

1. **Autenticación** → `401 UNAUTHENTICATED`.
2. **`Idempotency-Key` presente y UUID v4** → `400 MISSING_IDEMPOTENCY_KEY`.
3. **Cuerpo JSON parseable + esquema Zod** → `422 VALIDATION_ERROR` con `details[]` por campo.
4. **Replay de idempotencia:** si existe `Publication(userId, idempotencyKey)`:
   - `requestHash` idéntico → **`200 OK`** con la publicación existente y header `Idempotent-Replay: true`. No se re-publica.
   - `requestHash` distinto → `422 IDEMPOTENCY_KEY_REUSED`.
5. **Cuota / rate limit** → `429 RATE_LIMITED` + `Retry-After`.
6. **Resolución de conexiones**, por cada red de `networks`:
   - 0 conexiones activas → target inválido, motivo `NETWORK_NOT_CONNECTED`.
   - >1 y sin `connectionIds[network]` → target inválido, motivo `AMBIGUOUS_CONNECTION`.
   - `connectionIds[network]` apunta a una conexión de otro usuario o de otra red → `404 CONNECTION_NOT_FOUND` (nunca `403`: no se confirma la existencia de recursos ajenos).
   - conexión en `REAUTH_REQUIRED`/`REVOKED` → target inválido, motivo `REAUTH_REQUIRED`.
7. **Longitud del texto por red** (usa `provider.capabilities.maxTextLength`; en X, longitud ponderada):
   - excede → target inválido, motivo `TEXT_TOO_LONG` con `{ limit, actual }`.
8. **Decisión sobre targets inválidos:**
   - `allowPartialSuccess: true` (default) y **al menos un target válido** → `202`; los inválidos se crean en estado `skipped` con su `error`.
   - `allowPartialSuccess: false` **o ningún target válido** → `422 NO_PUBLISHABLE_TARGET` con el detalle por red. No se crea la publicación.
9. **`validateOnly: true`** → `200 OK` con la resolución (targets + errores) y sin persistir nada.

### 4.5 Ejecución (post-`202`)

```
POST /publish
   │
   ├─ tx: INSERT publication + N publication_targets (PENDING)   ← atómico
   ├─ enqueue N jobs `publish.target` (uno por target válido)
   └─ 202 Accepted

worker publish.target(targetId)
   │
   ├─ SELECT ... FOR UPDATE SKIP LOCKED  → si status ≠ PENDING, salir (protección anti-doble-entrega)
   ├─ status = PROCESSING, attempts++
   ├─ TokenVault.resolveConnection(connectionId)      ← refresca si hace falta
   ├─ provider.publishText({ text, connection, idempotencyKey })
   │     ok    → PUBLISHED (externalPostId, permalink, publishedAt)
   │     error → provider.normalizeError()
   │               retryable  → nextAttemptAt = now + backoff(attempts); status = PENDING
   │               terminal   → FAILED (+ si es REAUTH_REQUIRED, marca la conexión)
   └─ recomputar Publication.status (completed | partial | failed) cuando no quedan targets abiertos
```

- **Backoff:** exponencial con jitter completo — `min(2^attempts * 1000ms, 15min) * random(0.5, 1.5)`. Máximo **5 intentos**; después, `FAILED` definitivo.
- **Nunca se reintenta:** `REAUTH_REQUIRED`, `TEXT_TOO_LONG`, `DUPLICATE_CONTENT`, `CONTENT_REJECTED`, `FORBIDDEN`. Reintentar es, en el mejor caso, ruido; en el peor, un bloqueo de la app por parte del proveedor.
- **Aislamiento entre targets:** cada target es un job independiente. Un timeout en Meta no retrasa ni afecta a X.
- **Idempotencia hacia el proveedor:** ninguna de las tres APIs ofrece `Idempotency-Key`. La garantía es local: el `SELECT ... FOR UPDATE SKIP LOCKED` + la transición `PENDING → PROCESSING` asegura *at-most-once* por target, a costa de que un crash entre "API respondió 201" y "commit local" deje el target como fallido pese a haberse publicado. Se mitiga con una **verificación de reconciliación** antes de cada reintento (`attempts > 0` → consultar los últimos posts de la cuenta y comparar contenido + ventana temporal) antes de re-publicar.

### 4.6 Endpoints relacionados (misma familia v1)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/posts/{id}` | Estado de una publicación y sus targets |
| `GET` | `/api/v1/posts` | Historial paginado (cursor-based) |
| `DELETE` | `/api/v1/posts/{id}` | Cancela una publicación programada aún no ejecutada (`409` si ya salió) |
| `POST` | `/api/v1/posts/{id}/retry` | Reintenta solo los targets en `failed` y `retryable` |
| `GET` | `/api/v1/connections` | Conexiones del usuario, con `status` y `expiresAt` (sin tokens) |
| `DELETE` | `/api/v1/connections/{id}` | Revoca en el proveedor y borra los tokens locales |

### 4.7 OpenAPI (fragmento normativo)

```yaml
openapi: 3.1.0
info: { title: Posty API, version: "1.0.0" }
paths:
  /api/v1/posts/publish:
    post:
      operationId: publishPost
      summary: Encola una publicación hacia una o más redes sociales
      security: [{ sessionCookie: [] }, { bearerApiKey: [] }]
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema: { type: string, format: uuid }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/PublishRequest' }
      responses:
        "202":
          description: Publicación aceptada y encolada
          headers:
            Location: { schema: { type: string } }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/PublicationEnvelope' }
        "200":
          description: Replay idempotente, o resultado de validateOnly
          headers:
            Idempotent-Replay: { schema: { type: boolean } }
        "400": { $ref: '#/components/responses/Error' }   # petición malformada
        "401": { $ref: '#/components/responses/Error' }   # no autenticado
        "404": { $ref: '#/components/responses/Error' }   # connectionId inexistente
        "409": { $ref: '#/components/responses/Error' }   # conflicto de estado
        "422": { $ref: '#/components/responses/Error' }   # validación / sin targets publicables
        "429": { $ref: '#/components/responses/Error' }   # rate limit
        "503": { $ref: '#/components/responses/Error' }   # cola no disponible
components:
  schemas:
    PublishRequest:
      type: object
      required: [text, networks]
      properties:
        text:     { type: string, minLength: 1, maxLength: 63206 }
        networks:
          type: array
          minItems: 1
          maxItems: 3
          uniqueItems: true
          items: { type: string, enum: [twitter, linkedin, facebook] }
        options:
          type: object
          properties:
            connectionIds:       { type: object, additionalProperties: { type: string } }
            scheduledAt:         { type: [string, "null"], format: date-time }
            validateOnly:        { type: boolean, default: false }
            allowPartialSuccess: { type: boolean, default: true }
```

---

## 5. Modelo de errores

### 5.1 Formato único de error (RFC 9457 *problem details*, aplanado)

```json
{
  "error": {
    "code": "NO_PUBLISHABLE_TARGET",
    "message": "Ninguna de las redes solicitadas puede publicar en este momento.",
    "requestId": "req_01HQ8Z3K7V2N5M4Q",
    "details": [
      { "network": "twitter",  "code": "TEXT_TOO_LONG",        "limit": 280, "actual": 412 },
      { "network": "facebook", "code": "NETWORK_NOT_CONNECTED" }
    ],
    "docs": "https://docs.posty.app/errors/NO_PUBLISHABLE_TARGET"
  }
}
```

`message` es apto para mostrar al usuario final. Los detalles técnicos van a los logs con `requestId` como correlación; **nunca** se filtra el cuerpo crudo del proveedor al cliente (puede contener identificadores internos o fragmentos de token).

### 5.2 Catálogo

| `code` | HTTP | Retryable | Significado |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | ❌ | Sesión o API key ausente/inválida |
| `MISSING_IDEMPOTENCY_KEY` | 400 | ❌ | Falta el header o no es UUID v4 |
| `IDEMPOTENCY_KEY_REUSED` | 422 | ❌ | Misma clave, cuerpo distinto |
| `VALIDATION_ERROR` | 422 | ❌ | El cuerpo no cumple el esquema |
| `CONNECTION_NOT_FOUND` | 404 | ❌ | `connectionId` inexistente o de otro usuario |
| `AMBIGUOUS_CONNECTION` | 409 | ❌ | Varias conexiones activas en esa red y no se especificó cuál |
| `NETWORK_NOT_CONNECTED` | 422 | ❌ | El usuario no tiene conexión activa en esa red |
| `TEXT_TOO_LONG` | 422 | ❌ | Supera el límite de la red destino |
| `NO_PUBLISHABLE_TARGET` | 422 | ❌ | Ninguna red destino es publicable |
| `RATE_LIMITED` | 429 | ✅ | Cuota de Posty o del proveedor agotada. Incluye `Retry-After` |
| `REAUTH_REQUIRED` | — (nivel target) | ❌ | El proveedor invalidó las credenciales; requiere reconexión del usuario |
| `PROVIDER_UNAVAILABLE` | — (nivel target) | ✅ | 5xx o timeout del proveedor |
| `DUPLICATE_CONTENT` | — (nivel target) | ❌ | El proveedor rechaza contenido idéntico reciente (típico en X) |
| `CONTENT_REJECTED` | — (nivel target) | ❌ | Rechazo por políticas del proveedor |
| `INTERNAL_ERROR` | 500 | ✅ | Fallo no clasificado. Siempre acompañado de `requestId` |
| `QUEUE_UNAVAILABLE` | 503 | ✅ | No se pudo encolar; nada se persistió |

### 5.3 Normalización por proveedor

Cada adaptador traduce en `normalizeError()`. Extracto de las reglas relevantes:

| Proveedor | Señal | → `code` |
|---|---|---|
| X | `401` / `invalid_grant` en refresh | `REAUTH_REQUIRED` |
| X | `403` con `detail` "duplicate content" | `DUPLICATE_CONTENT` |
| X | `429` + `x-rate-limit-reset` | `RATE_LIMITED` (`Retry-After` = reset − now) |
| LinkedIn | `401` `serviceErrorCode: 65600` (token inválido/expirado) | `REAUTH_REQUIRED` |
| LinkedIn | `403` `ACCESS_DENIED` sobre `w_member_social` | `REAUTH_REQUIRED` |
| LinkedIn | `429` | `RATE_LIMITED` |
| Meta | `OAuthException` `code: 190` (cualquier `error_subcode`) | `REAUTH_REQUIRED` |
| Meta | `code: 200` (permiso faltante) | `REAUTH_REQUIRED` |
| Meta | `code: 4` / `17` / `32` (application o user request limit) | `RATE_LIMITED` |
| Meta | `code: 1` / `2` (transitorio) | `PROVIDER_UNAVAILABLE` |
| Cualquiera | `5xx`, `ECONNRESET`, `ETIMEDOUT`, `AbortError` | `PROVIDER_UNAVAILABLE` |

---

## 6. Estructura de carpetas

```
posty/
├── app/
│   ├── (marketing)/                     # landing pública
│   ├── (app)/
│   │   ├── layout.tsx                   # exige sesión
│   │   ├── compose/page.tsx             # editor + selector de redes
│   │   ├── history/page.tsx
│   │   └── settings/connections/page.tsx
│   └── api/
│       ├── auth/
│       │   └── [network]/
│       │       ├── connect/route.ts     # inicia OAuth (state + PKCE)
│       │       └── callback/route.ts    # intercambia code, cifra y persiste
│       ├── v1/
│       │   ├── posts/
│       │   │   ├── publish/route.ts     # ← el contrato de §4
│       │   │   └── [id]/route.ts
│       │   └── connections/
│       │       ├── route.ts
│       │       └── [id]/route.ts
│       ├── webhooks/
│       │   └── meta/route.ts            # deauthorize + data deletion callbacks (obligatorios)
│       ├── jobs/
│       │   └── publish-target/route.ts  # consumidor de la cola (firma HMAC)
│       └── cron/
│           └── token-maintenance/route.ts
│
├── lib/
│   ├── api/
│   │   ├── handler.ts                   # withAuth · withValidation · withIdempotency · withRateLimit
│   │   ├── errors.ts                    # PostyError + mapa a HTTP
│   │   └── v1/schemas/                  # Zod = fuente de verdad del contrato
│   ├── domain/
│   │   ├── publish-service.ts           # orquestación, resolución de targets, transacción
│   │   ├── connection-service.ts
│   │   └── policies.ts                  # cuotas, límites por plan
│   ├── providers/                       # 'server-only'
│   │   ├── types.ts                     # SocialProvider (§1.3)
│   │   ├── registry.ts                  # NetworkId → SocialProvider
│   │   ├── twitter/{oauth,client,text,errors}.ts
│   │   ├── linkedin/{oauth,client,text,errors}.ts
│   │   └── meta/{oauth,client,pages,errors}.ts
│   ├── vault/                           # 'server-only'
│   │   ├── crypto.ts                    # seal/open AES-256-GCM
│   │   ├── kms.ts                       # DEK: generate/decrypt + caché LRU
│   │   └── token-vault.ts               # resolveConnection, refresh con lock
│   ├── queue/
│   │   ├── producer.ts
│   │   └── jobs/publish-target.ts
│   ├── db/prisma.ts
│   └── observability/{logger,metrics,redact}.ts
│
├── prisma/{schema.prisma,migrations/}
├── tests/
│   ├── unit/                            # normalización de errores, longitud ponderada, seal/open
│   ├── contract/                        # esquemas Zod ↔ OpenAPI
│   └── integration/                     # adaptadores contra MSW con fixtures reales
└── ARCHITECTURE.md
```

---

## 7. Operación: rate limits, observabilidad, seguridad

### 7.1 Rate limits

**Límites del proveedor** (a fecha de este documento; se verifican contra la documentación oficial en cada revisión del adaptador):

| Red | Endpoint | Límite aproximado |
|---|---|---|
| X | `POST /2/tweets` | Por usuario y por app, según el nivel de acceso contratado |
| LinkedIn | `POST /rest/posts` | Diario por miembro y por aplicación |
| Meta | `POST /{page-id}/feed` | Basado en el *Business Use Case rate limiting* (`X-Business-Use-Case-Usage`) |

**Estrategia:**

- **Token bucket por `(connectionId, network)`** en Redis, calibrado por debajo del límite del proveedor. El worker consume del bucket antes de llamar; si no hay cupo, reprograma el job en lugar de gastar una llamada en un `429`.
- Las cabeceras de cuota que devuelve cada proveedor (`x-rate-limit-remaining` en X, `X-Business-Use-Case-Usage` en Meta) **alimentan de vuelta al bucket**: la fuente de verdad es el proveedor, no nuestra estimación.
- Límite de entrada propio: 60 publicaciones/hora por usuario (ajustable por plan) con `429` + `Retry-After`.

### 7.2 Observabilidad

- **Logs estructurados** (JSON) con `requestId`, `userId`, `publicationId`, `targetId`, `network`. Redactor obligatorio sobre las claves `access_token`, `refresh_token`, `client_secret`, `code`, `code_verifier`, `appsecret_proof`, `authorization`, `cookie`.
- **Métricas:** `posty_publish_duration_seconds{network}`, `posty_publish_total{network,status}`, `posty_token_refresh_total{network,result}`, `posty_connection_status{network,status}`, `posty_provider_errors_total{network,code}`.
- **Alertas:** tasa de `REAUTH_REQUIRED` por red > 5 %/hora (señal de cambio de política o de una app suspendida); `PROVIDER_UNAVAILABLE` sostenido > 10 min; cualquier fallo de `open()` (descifrado) — indica corrupción o intento de sustitución de ciphertext.
- **Trazas:** un span por target, hijo del span de la request, con el proveedor como atributo.

### 7.3 Seguridad — checklist de implementación

- [ ] `import 'server-only'` en `lib/vault/**` y `lib/providers/**`.
- [ ] Ningún DTO de API expone campos de token; test de contrato que lo verifica sobre la respuesta serializada.
- [ ] `state` OAuth single-use, TTL 10 min, ligado a `userId`, validado en el callback.
- [ ] `redirect_uri` fija por entorno; nunca derivada de headers del request.
- [ ] PKCE S256 en X; verifier cifrado en reposo mientras el flujo está abierto.
- [ ] `appsecret_proof` en todas las llamadas a Meta + "Require App Secret" activado.
- [ ] CSRF: `SameSite=Lax` + verificación de `Origin` en mutaciones con cookie. Las API keys (`Bearer`) están exentas por no ser credenciales ambientales.
- [ ] Webhooks de Meta (`deauthorize_callback`, `data_deletion_callback`) implementados con verificación de firma — **requisito de la plataforma**, no opcional.
- [ ] `DELETE /connections/{id}` revoca en el proveedor **antes** de borrar localmente; si la revocación remota falla, se borra igual y se registra en auditoría (nunca dejar tokens huérfanos por un 5xx ajeno).
- [ ] Borrado de cuenta → cascada a conexiones y tokens + revocación remota (GDPR art. 17).
- [ ] Rotación de CMK anual; re-cifrado perezoso en lectura vía `keyVersion`.

### 7.4 Testing

| Nivel | Qué cubre |
|---|---|
| Unit | `seal`/`open` (incluido AAD incorrecto → debe fallar), longitud ponderada de X, escapado de LinkedIn, `normalizeError` con fixtures reales de cada proveedor |
| Contract | Zod ↔ OpenAPI en sincronía; snapshot de las respuestas `202`/`422` |
| Integration | Adaptadores contra MSW con respuestas grabadas: happy path, `401`, `429`, `5xx`, refresh rotativo, refresh concurrente |
| E2E | Flujo completo de conexión (proveedores mockeados) + publicación a 3 redes con una fallando → estado `partial` |
| Carga | 100 publicaciones concurrentes: verificar que no hay doble publicación ni pérdida de refresh token en X |

---

## 8. Riesgos abiertos y roadmap

### 8.1 Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **App Review** de Meta / LinkedIn / X no aprobado a tiempo | Bloqueante para el lanzamiento | Iniciar el proceso en paralelo al desarrollo; entorno de desarrollo con cuentas de prueba del propio equipo |
| **Rotación de refresh token de X** con concurrencia | Pérdida permanente de conexiones | Lock pesimista (§3.5) + test de carga específico + alerta sobre `token_refresh_total{result="invalid_grant"}` |
| **LinkedIn sin refresh token** para apps no aprobadas | Reconexión manual cada 60 días | Estado `EXPIRING` + notificación a los 53 días; solicitar el programa de refresh tokens |
| **Cambios de versión de las APIs** (Meta deprecia versiones cada ~2 años) | Rotura silenciosa | Versión pinneada en constante (`META_API_VERSION`), test de integración diario contra el entorno real, monitorización de las notas de deprecación |
| Fallo de KMS | Imposible publicar | Caché LRU de DEK (5 min) absorbe cortes breves; alerta y degradación explícita con `503`, nunca fallback a texto plano |

### 8.2 Roadmap

| Fase | Alcance |
|---|---|
| **v1.0** (este documento) | Texto plano · 3 redes · publicación inmediata y programada · fallo parcial · idempotencia |
| **v1.1** | Multimedia (imágenes): `POST /2/media/upload` en X, *Images API* en LinkedIn, `/photos` en Meta. El contrato añade `media[]` sin romper v1 |
| **v1.2** | Hilos en X, artículos en LinkedIn, adaptación de texto por red (`textOverrides: Record<network, string>`) |
| **v1.3** | Instagram Business (mismo adaptador Meta, distinto grafo), Threads, Mastodon/Bluesky |
| **v2.0** | Analíticas post-publicación (métricas de engagement por target), equipos y aprobaciones |

---

## Apéndice A — Variables de entorno

```dotenv
# App
DATABASE_URL=postgresql://...
APP_URL=https://posty.app
SESSION_SECRET=                 # 32+ bytes aleatorios

# Cifrado
KMS_PROVIDER=aws                # aws | gcp | local
KMS_KEY_ID=arn:aws:kms:...      # CMK no exportable
KMS_KEY_VERSION=1

# X (Twitter API v2)
TWITTER_CLIENT_ID=
TWITTER_CLIENT_SECRET=
TWITTER_REDIRECT_URI=https://posty.app/api/auth/twitter/callback

# LinkedIn
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=https://posty.app/api/auth/linkedin/callback
LINKEDIN_API_VERSION=202409     # header LinkedIn-Version

# Meta
META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=https://posty.app/api/auth/facebook/callback
META_API_VERSION=v21.0
META_WEBHOOK_VERIFY_TOKEN=

# Infra
REDIS_URL=
QUEUE_SIGNING_KEY=              # HMAC de los jobs entrantes en /api/jobs/*
CRON_SECRET=
```

> **Regla:** ningún secreto lleva el prefijo `NEXT_PUBLIC_`. Un `grep -r "NEXT_PUBLIC_.*SECRET\|NEXT_PUBLIC_.*TOKEN" app/ lib/` en CI falla el build.

## Apéndice B — Ejemplo de uso (cliente TypeScript)

```ts
const res = await fetch('/api/v1/posts/publish', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    text: 'Publicando en tres redes desde Posty.',
    networks: ['twitter', 'linkedin', 'facebook'],
  }),
});

if (res.status === 202) {
  const { data, meta } = await res.json();
  // Polling hasta estado terminal; en producción, preferir el webhook `publication.completed`.
  const final = await pollUntilTerminal(meta.pollUrl);
  const failed = final.data.targets.filter((t) => t.status === 'failed');
  if (failed.length) showPartialFailure(failed);  // incluye reconnectUrl si aplica
}
```
