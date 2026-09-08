# @posty/api — Integración de publicación multi-red

Lógica de integración con **X / Twitter API v2**, **LinkedIn REST API** y **Meta Graph API
(Facebook Pages)** y el handler `POST /api/v1/posts/publish` que ejecuta las publicaciones
en paralelo y devuelve el estado individual por red.

> Contexto de arquitectura completo en `../../ARCHITECTURE.md`. Esta entrega cubre el
> alcance pedido: texto plano, fan-out **síncrono** con `Promise.allSettled()` y
> normalización de respuestas. La cola asíncrona (`202 Accepted`), el TokenVault y la
> idempotencia descritos en §3–§4 del documento quedan fuera de este módulo.

## Puesta en marcha

```bash
npm install
cp .env.example .env      # valores por defecto ya funcionan en desarrollo
npm run dev                # servidor en http://localhost:3000
npm test                   # 24 tests (adaptadores + fan-out + handler)
npm run typecheck
```

## Estructura

```
src/
├── config/env.ts             # versiones de API pinneadas + timeouts (Zod)
├── http/httpClient.ts        # cliente fetch estandarizado -> HttpError | HttpTransportError
├── providers/
│   ├── types.ts              # interfaz SocialProvider (publishText)
│   ├── errors.ts             # PublishError + códigos + normalización genérica
│   ├── twitter.ts            # POST /2/tweets
│   ├── linkedin.ts           # POST /rest/posts (headers de versión, escapado LTF)
│   ├── facebook.ts           # POST /{v}/{page-id}/feed (+ appsecret_proof)
│   └── registry.ts           # NetworkId -> SocialProvider
├── posts/
│   ├── publishRequest.ts     # esquema Zod de la request
│   ├── publishService.ts     # fan-out con Promise.allSettled + normalización
│   └── publishHandler.ts     # handler Express
├── app.ts                    # wiring Express (inyección de dependencias para tests)
└── index.ts                  # bootstrap
```

## `POST /api/v1/posts/publish`

Las credenciales de cada red llegan en la request (en producción las resolvería el
TokenVault). Solo se publica en las redes presentes en `targets`.

### Request

```jsonc
{
  "text": "Publicando en tres redes desde Posty.",
  "targets": {
    "twitter":  { "accessToken": "..." },
    "linkedin": { "accessToken": "...", "authorUrn": "urn:li:person:xxxx" },
    "facebook": { "pageId": "123456", "pageAccessToken": "..." }
  }
}
```

### Response

| `summary.outcome` | HTTP | Significado |
|---|---|---|
| `completed` | `200` | todas las redes publicaron |
| `partial`   | `207` | al menos una publicó y al menos una falló |
| `failed`    | `502` | ninguna publicó |
| —           | `422` | el cuerpo no cumple el esquema |
| —           | `400` | JSON malformado |

```jsonc
{
  "data": {
    "text": "Publicando en tres redes desde Posty.",
    "results": {
      "twitter":  { "status": "ok", "id": "1832…", "permalink": "https://x.com/…", "publishedAt": "…" },
      "linkedin": { "status": "failed", "reason": "La conexión con LinkedIn ha expirado…",
                    "code": "REAUTH_REQUIRED", "retryable": false, "providerStatus": 401 },
      "facebook": { "status": "ok", "id": "123_456", "permalink": "https://www.facebook.com/…", "publishedAt": "…" }
    },
    "summary": { "outcome": "partial", "ok": ["twitter", "facebook"], "failed": ["linkedin"] }
  },
  "meta": { "requestId": "req_…" }
}
```

### Códigos de error por red (`results.<red>.code`)

`REAUTH_REQUIRED` · `RATE_LIMITED` (+ `retryAfterSeconds`) · `PROVIDER_UNAVAILABLE` ·
`DUPLICATE_CONTENT` · `CONTENT_REJECTED` · `TEXT_TOO_LONG` · `INVALID_REQUEST` ·
`INTERNAL_ERROR`. `retryable: true` solo en `RATE_LIMITED`, `PROVIDER_UNAVAILABLE` e
`INTERNAL_ERROR` (mapeo de `ARCHITECTURE.md` §5.2–§5.3).

## Decisiones

- **`fetch` nativo, sin SDKs de terceros.** Un único `HttpClient` centraliza timeout
  (`AbortController`), parseo de cuerpo y forma de error. Cada adaptador solo declara
  URL, headers y su `normalizeError`.
- **`Promise.allSettled` y no `Promise.all`.** El fallo de una red nunca cancela ni
  contamina a las demás. El servicio traduce cada entrada `fulfilled`/`rejected` a un
  `TargetResult` (`ok` | `failed`).
- **`PublishError` es la única excepción que cruza el borde del adaptador.** Si algo no
  previsto escapa, el servicio lo degrada a `INTERNAL_ERROR` sin tumbar el fan-out.
- **Versiones de API en configuración** (`LINKEDIN_API_VERSION`, `META_API_VERSION`):
  Meta y LinkedIn versionan de forma agresiva.
- **`appsecret_proof`** se envía a Meta si `META_APP_SECRET` está definido.
