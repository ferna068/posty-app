# Posty — Plan de Trabajo (Backlog)

> **Documento vivo.** Se actualiza en cada PR: quien cierra un ticket cambia su estado aquí en el mismo commit.
> **Especificación de referencia:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) — cada ticket enlaza a la sección que lo define.
> **Última actualización:** 2026-09-07

---

## Leyenda

### Estado

| Símbolo | Estado | Significado |
|---|---|---|
| ✅ | **Done** | Implementado, testeado y mergeado a `main` |
| 🔄 | **In Progress** | Hay una rama abierta con trabajo activo |
| ⬜ | **Todo** | Sin empezar |
| 🚫 | **Blocked** | Bloqueado por una dependencia externa (App Review, credenciales, decisión de producto) |

### Rol

| Etiqueta | Rol | Alcance |
|---|---|---|
| **BE** | Backend | Route Handlers, servicios de dominio, adaptadores de proveedor, Prisma, colas, cifrado |
| **FE** | Frontend | Server/Client Components, UI, formularios, estados de carga y error |
| **BE+FE** | Full-stack | Requiere contrato + consumo. Se puede partir en dos subtareas si hay dos personas |
| **OPS** | Operaciones | Consolas de desarrollador, App Review, secretos, infraestructura. No es código |

---

## Resumen de estado

| Épica | Tickets | ✅ Done | 🔄 En curso | ⬜ Todo | 🚫 Bloqueado |
|---|---|---|---|---|---|
| E0 · Fundaciones | 6 | 2 | 0 | 4 | 0 |
| E1 · Identidad de Posty | 4 | 0 | 0 | 4 | 0 |
| E2 · Cifrado y TokenVault | 5 | 0 | 0 | 5 | 0 |
| E3 · Conexiones OAuth | 5 | 0 | 0 | 5 | 0 |
| E4 · Publicación | 19 | 0 | 0 | 19 | 0 |
| E5 · Operación y ciclo de vida | 6 | 0 | 0 | 6 | 0 |
| E6 · Compliance y App Review | 5 | 0 | 0 | 1 | 4 |
| E7 · Calidad y verificación | 4 | 0 | 0 | 4 | 0 |
| E8 · Apartado de configuración | 11 | 0 | 0 | 11 | 0 |
| **Total** | **65** | **2** | **0** | **59** | **4** |

**Reparto por rol:** BE 40 · FE 11 · BE+FE 10 · OPS 4

---

## E0 · Fundaciones

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-001 | Especificación de arquitectura (`ARCHITECTURE.md`) | BE | ✅ Done | — | OAuth, esquema de datos y contrato de publicación definidos y revisados |
| PST-002 | Backlog y plan de trabajo (`PLANNING.md`) | BE | ✅ Done | PST-001 | Todos los tickets con rol, estado y dependencias |
| PST-003 | Bootstrap Next.js App Router + TypeScript `strict` | BE+FE | ⬜ Todo | — | `pnpm dev` levanta; `tsconfig` con `strict`, `noUncheckedIndexedAccess`; ESLint + Prettier en pre-commit |
| PST-004 | PostgreSQL + Prisma + migración inicial ([§3.3](./ARCHITECTURE.md#33-esquema-prisma)) | BE | ⬜ Todo | PST-003 | `schema.prisma` completo aplicado; `prisma migrate dev` reproducible desde cero |
| PST-005 | Logger estructurado + redactor de secretos ([§7.2](./ARCHITECTURE.md#72-observabilidad)) | BE | ⬜ Todo | PST-003 | Test que verifica que `access_token`, `refresh_token`, `code_verifier` y `authorization` salen como `[redacted]` |
| PST-006 | CI: typecheck, lint, tests y guard de secretos públicos | BE | ⬜ Todo | PST-003 | El pipeline falla si aparece `NEXT_PUBLIC_*SECRET|TOKEN` ([Apéndice A](./ARCHITECTURE.md#apéndice-a--variables-de-entorno)) |

---

## E1 · Identidad de Posty

> Login del usuario en la app. Deliberadamente **separado** de las conexiones sociales ([§2.1](./ARCHITECTURE.md#21-dos-planos-de-identidad-deliberadamente-separados)).

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-010 | Modelo `User` + sesión (cookie `httpOnly`, `SameSite=Lax`, `Secure`) | BE | ⬜ Todo | PST-004 | Sesión firmada, expiración e invalidación; sin datos sensibles en la cookie |
| PST-011 | Pantallas de registro / login / recuperación | FE | ⬜ Todo | PST-010 | Validación en cliente y servidor con el mismo esquema Zod; estados de error accesibles |
| PST-012 | Protección de rutas del grupo `(app)` | BE+FE | ⬜ Todo | PST-010 | Acceso sin sesión redirige a login conservando `returnTo`; verificado en Server Component, no solo en middleware |
| PST-013 | Layout de la aplicación + navegación | FE | ⬜ Todo | PST-003 | Shell con navegación, estado de sesión y slots de carga (`loading.tsx`) |

---

## E2 · Cifrado y TokenVault

> Núcleo de seguridad. **Ningún ticket de E3 o E4 puede mergearse antes que PST-020 y PST-022.**

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-020 | `seal`/`open` AES-256-GCM con AAD ([§3.2](./ARCHITECTURE.md#32-envelope-encryption--diseño)) | BE | ⬜ Todo | PST-003 | Formato `v1.{keyVersion}.{iv}.{tag}.{ct}`; test que confirma que descifrar con **AAD distinta falla** |
| PST-021 | Proveedor KMS + caché LRU de DEK (TTL 5 min) | BE | ⬜ Todo | PST-020 | Abstracción `aws \| gcp \| local`; un corte breve de KMS no interrumpe publicaciones en curso |
| PST-022 | `TokenVault.resolveConnection` con lock pesimista ([§3.5](./ARCHITECTURE.md#35-tokenvault--el-único-punto-de-acceso-a-credenciales)) | BE | ⬜ Todo | PST-021, PST-004 | Refresco transparente con margen de 300 s; `SELECT … FOR UPDATE` sobre `social_tokens` |
| PST-023 | Test de concurrencia de la rotación de refresh de X ([§2.3](./ARCHITECTURE.md#23-x--twitter-api-v2)) | BE | ⬜ Todo | PST-022 | 20 refrescos simultáneos sobre la misma conexión → **1 solo** intercambio real, 0 conexiones perdidas |
| PST-024 | Rotación de CMK y re-cifrado perezoso por `keyVersion` | BE | ⬜ Todo | PST-021 | Un registro con `keyVersion` antigua se descifra y se re-sella en la siguiente lectura |

---

## E3 · Conexiones OAuth

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-030 | Infraestructura OAuth común: `OAuthState`, PKCE, callback genérico ([§2.2](./ARCHITECTURE.md#22-flujo-común-authorization-code)) | BE | ⬜ Todo | PST-022 | `state` single-use con TTL 10 min ligado a `userId`; `redirect_uri` fija por entorno; segundo callback → `409` |
| PST-031 | Interfaz `SocialProvider` + registry ([§1.3](./ARCHITECTURE.md#13-la-interfaz-que-todo-proveedor-implementa)) | BE | ⬜ Todo | PST-003 | `lib/providers/**` marcado `import 'server-only'`; el dominio no importa nada específico de proveedor |
| PST-032 | Adaptador **X**: OAuth 2.0 + PKCE S256 + refresh rotativo | BE | ⬜ Todo | PST-030, PST-031 | Conexión completa contra la API real con cuenta de pruebas; refresh verificado |
| PST-033 | Adaptador **LinkedIn**: OAuth + `userinfo` + manejo de ausencia de refresh token | BE | ⬜ Todo | PST-030, PST-031 | Si no hay `refresh_token`, la conexión se guarda con `expiresAt` a 60 días y entra en el ciclo `EXPIRING` |
| PST-034 | Adaptador **Meta**: short-lived → long-lived → Page Token + `appsecret_proof` ([§2.5](./ARCHITECTURE.md#25-meta-graph-api--facebook-pages)) | BE | ⬜ Todo | PST-030, PST-031 | Se persisten ambos tokens (`ACCESS` de página y `LONG_LIVED_USER`); todas las llamadas firmadas |

> El **apartado de configuración** que consume estos adaptadores (pantalla de conexiones, selector de Páginas, reconexión y desconexión) se detalla en la épica [E8](#e8--apartado-de-configuración-ajustes--conexiones).

---

## E4 · Publicación

### E4.a — Contrato y orquestación (backend)

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-040 | Esquemas Zod del contrato v1 ([§4.2](./ARCHITECTURE.md#42-request)) | BE | ⬜ Todo | PST-003 | `PublishRequestSchema` es la fuente de verdad; tipos derivados con `z.infer` |
| PST-041 | Resolución de targets y validación en 9 pasos ([§4.4](./ARCHITECTURE.md#44-reglas-de-validación-orden-de-evaluación)) | BE | ⬜ Todo | PST-040, PST-031 | Cubre `AMBIGUOUS_CONNECTION`, `NETWORK_NOT_CONNECTED`, `TEXT_TOO_LONG` y `REAUTH_REQUIRED` |
| PST-042 | Idempotencia por `Idempotency-Key` + `requestHash` | BE | ⬜ Todo | PST-040, PST-004 | Misma clave y mismo cuerpo → `200` + `Idempotent-Replay: true`; cuerpo distinto → `422` |
| PST-043 | `POST /api/v1/posts/publish` → `202 Accepted` ([§4.3](./ARCHITECTURE.md#43-response-202-accepted)) | BE | ⬜ Todo | PST-041, PST-042 | Inserción atómica de `Publication` + N `PublicationTarget`; header `Location` presente |
| PST-044 | Cola + worker `publish.target` con backoff y jitter ([§4.5](./ARCHITECTURE.md#45-ejecución-post-202)) | BE | ⬜ Todo | PST-043 | `FOR UPDATE SKIP LOCKED`; máx. 5 intentos; los errores terminales no se reintentan |
| PST-045 | Recómputo de `Publication.status` (`completed` / `partial` / `failed`) | BE | ⬜ Todo | PST-044 | Con 2 de 3 targets publicados el estado final es `partial`, no `failed` |
| PST-046 | `GET /api/v1/posts/{id}` y `GET /api/v1/posts` (cursor) | BE | ⬜ Todo | PST-043 | Respuesta idéntica al ejemplo de fallo parcial de [§4.3](./ARCHITECTURE.md#43-response-202-accepted) |
| PST-047 | `POST /api/v1/posts/{id}/retry` (solo targets `failed` y reintentables) | BE | ⬜ Todo | PST-045 | No re-publica targets ya en `published` |
| PST-048 | Publicación programada `scheduledAt` + cron de disparo | BE | ⬜ Todo | PST-044 | Ventana válida `now+5min … now+90d`; `DELETE` cancela si aún no salió, `409` si ya salió |

### E4.b — Adaptadores de publicación (backend)

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-050 | `publishText` **X** + longitud ponderada `twitter-text` | BE | ⬜ Todo | PST-032 | `POST /2/tweets` devuelve id y permalink; contador validado con los vectores oficiales |
| PST-051 | `publishText` **LinkedIn** + escapado Little Text Format | BE | ⬜ Todo | PST-033 | `POST /rest/posts` con `LinkedIn-Version` y `X-Restli-Protocol-Version`; id leído de `x-restli-id` |
| PST-052 | `publishText` **Meta** (`/{page-id}/feed`) | BE | ⬜ Todo | PST-034 | Publica con el **Page Token**, no con el de usuario; `appsecret_proof` en la llamada |
| PST-053 | `normalizeError` de los tres proveedores ([§5.3](./ARCHITECTURE.md#53-normalización-por-proveedor)) | BE | ⬜ Todo | PST-050, PST-051, PST-052 | `OAuthException 190` y `serviceErrorCode 65600` → `REAUTH_REQUIRED`; `429` → `RATE_LIMITED` con `Retry-After` |
| PST-054 | Reconciliación anti-duplicado antes de reintentar ([§4.5](./ARCHITECTURE.md#45-ejecución-post-202)) | BE | ⬜ Todo | PST-044, PST-053 | Con `attempts > 0`, comprueba los últimos posts de la cuenta antes de re-publicar |

### E4.c — Interfaz de usuario (frontend)

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-055 | Editor `/compose` con selector de redes | FE | ⬜ Todo | PST-013, PST-092 | Solo permite marcar redes con conexión activa; el resto aparece deshabilitado con motivo |
| PST-056 | Contador de caracteres **por red** simultáneo | FE | ⬜ Todo | PST-055, PST-050 | 280 (ponderado) / 3.000 / 63.206; avisa antes de enviar, no después del `422` |
| PST-057 | Envío + `Idempotency-Key` + seguimiento del `202` | FE | ⬜ Todo | PST-043, PST-055 | Genera UUID v4 por intento de envío; reintento de red reutiliza la misma clave |
| PST-058 | Visualización de resultado parcial y reconexión | FE | ⬜ Todo | PST-046, PST-057 | Muestra por red: publicado con enlace, o error con `reconnectUrl` si es `REAUTH_REQUIRED` |
| PST-059 | Historial `/history` con estados y permalinks | FE | ⬜ Todo | PST-046 | Paginación por cursor; filtro por red y estado |

---

## E5 · Operación y ciclo de vida

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-060 | Rate limiting: token bucket por `(connectionId, network)` ([§7.1](./ARCHITECTURE.md#71-rate-limits)) | BE | ⬜ Todo | PST-044 | Realimentado con `x-rate-limit-remaining` y `X-Business-Use-Case-Usage`; sin cupo, reprograma en vez de gastar la llamada |
| PST-061 | Límite de entrada por usuario (60 pub/h) con `429` + `Retry-After` | BE | ⬜ Todo | PST-043 | Configurable por plan |
| PST-062 | Cron `token-maintenance` + transición a `EXPIRING` ([§3.6](./ARCHITECTURE.md#36-ciclo-de-vida-de-una-conexión)) | BE | ⬜ Todo | PST-022 | Refresca proactivamente lo refrescable; marca y notifica lo que no; protegido por `CRON_SECRET` |
| PST-063 | Notificación de reconexión (email + banner) | BE+FE | ⬜ Todo | PST-062, PST-092 | Aviso a los 53 días en LinkedIn; banner persistente si hay conexiones en `REAUTH_REQUIRED` |
| PST-064 | Métricas, trazas y alertas ([§7.2](./ARCHITECTURE.md#72-observabilidad)) | BE | ⬜ Todo | PST-005, PST-044 | Alerta si `REAUTH_REQUIRED` > 5 %/h por red, o ante cualquier fallo de `open()` |
| PST-065 | Borrado de cuenta con cascada y revocación remota (GDPR art. 17) | BE+FE | ⬜ Todo | PST-097 | Elimina conexiones y tokens y revoca en los tres proveedores; queda traza en `AuditLog` |

---

## E6 · Compliance y App Review

> ⚠️ **Ruta crítica del lanzamiento.** No son tickets de código, pero bloquean la operación con usuarios reales.
> **Arrancar ya, en paralelo al desarrollo** ([§8.1](./ARCHITECTURE.md#81-riesgos)).

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-070 | Meta: App Review de `pages_manage_posts` (Advanced Access) | OPS | 🚫 Blocked | PST-073, PST-071 | Aprobado; hasta entonces solo funcionan cuentas del equipo de desarrollo |
| PST-071 | Webhooks de Meta: `deauthorize_callback` y `data_deletion_callback` | BE | ⬜ Todo | PST-034 | Firma verificada; requisito **obligatorio** de plataforma, no opcional |
| PST-072 | X: nivel de acceso ≥ Basic para `tweet.write` | OPS | 🚫 Blocked | — | Plan contratado y límites de escritura confirmados |
| PST-073 | LinkedIn: productos *Sign In with OIDC* + *Share on LinkedIn* | OPS | 🚫 Blocked | — | Aprobados; solicitado además el programa de refresh tokens |
| PST-074 | Páginas legales: privacidad, términos y borrado de datos | OPS | 🚫 Blocked | — | URLs públicas exigidas por las tres consolas de desarrollador |

---

## E7 · Calidad y verificación

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-080 | Tests de contrato: Zod ↔ OpenAPI + snapshots `202`/`422` | BE | ⬜ Todo | PST-040 | El pipeline falla si el esquema y el OpenAPI divergen |
| PST-081 | Tests de integración de adaptadores con MSW | BE | ⬜ Todo | PST-053 | Fixtures reales para happy path, `401`, `429`, `5xx` y refresh rotativo |
| PST-082 | E2E: conectar 3 redes y publicar con una fallando | BE+FE | ⬜ Todo | PST-058, PST-081 | El estado final es `partial` y la UI lo refleja con el enlace de reconexión |
| PST-083 | Test de carga: 100 publicaciones concurrentes | BE | ⬜ Todo | PST-044, PST-023 | 0 publicaciones duplicadas, 0 refresh tokens de X perdidos |

---

## E8 · Apartado de configuración (`Ajustes → Conexiones`)

> Superficie donde el usuario conecta, revisa y desconecta sus cuentas de X, LinkedIn y Facebook.
> Especificación completa en [§2.7](./ARCHITECTURE.md#27-apartado-de-configuración--ajustes--conexiones).

| ID | Actividad | Rol | Estado | Depende de | Criterio de aceptación |
|---|---|---|---|---|---|
| PST-090 | Shell de `/settings` con navegación lateral ([§2.7.1](./ARCHITECTURE.md#271-ubicación-y-estructura)) | FE | ⬜ Todo | PST-013 | Secciones Perfil / Conexiones / Notificaciones / Cuenta; indicador de conexiones que requieren atención |
| PST-091 | `GET /api/v1/connections` + `ConnectionDTO` ([§2.7.5](./ARCHITECTURE.md#275-connectiondto--el-contrato-de-la-pantalla)) | BE | ⬜ Todo | PST-030 | Devuelve estado resuelto, permisos traducidos y `reconnectUrl`; **ningún campo de token** |
| PST-092 | Pantalla de conexiones: tarjeta por cuenta y 5 estados ([§2.7.3](./ARCHITECTURE.md#273-estados-de-la-tarjeta)) | FE | ⬜ Todo | PST-091, PST-090 | Server Component; agrupa por red; soporta N cuentas por red; estado anunciado por texto, no solo por color |
| PST-093 | Estado vacío con permisos declarados antes del redirect ([§2.7.7](./ARCHITECTURE.md#277-estado-vacío)) | FE | ⬜ Todo | PST-092 | Las tres redes con su descripción y los permisos que se solicitarán |
| PST-094 | Flujo *Conectar* y *Conectar otra cuenta* desde la UI | BE+FE | ⬜ Todo | PST-032, PST-033, PST-034, PST-092 | `returnTo` respetado; conectar una segunda cuenta de la misma red no pisa la primera |
| PST-095 | Selector de Páginas de Facebook tras el callback ([§2.7.4](./ARCHITECTURE.md#274-acciones-y-endpoints)) | BE+FE | ⬜ Todo | PST-034, PST-092 | `GET /me/accounts` lista las Páginas; **una conexión por Página** seleccionada; se pueden añadir más después |
| PST-096 | Reconexión preservando `connectionId` | BE+FE | ⬜ Todo | PST-094 | El callback hace *upsert* sobre la fila existente; los `PublicationTarget` históricos no pierden la referencia |
| PST-097 | Desconexión: modal de confirmación + revocación remota + borrado local | BE+FE | ⬜ Todo | PST-091 | El modal avisa de las publicaciones programadas que se cancelarán; si la revocación remota falla, se borra igual y queda en `AuditLog` |
| PST-098 | `POST /api/v1/connections/{id}/verify` + acción *Probar conexión* | BE+FE | ⬜ Todo | PST-091, PST-022 | Llamada de coste mínimo al proveedor; actualiza `status`; rate limit 10/10 min |
| PST-099 | Notificaciones de vuelta del callback ([§2.7.6](./ARCHITECTURE.md#276-vuelta-del-callback)) | FE | ⬜ Todo | PST-094 | Traduce `?connected` / `?error`; limpia la URL con `replaceState`; `access_denied` en tono neutro, no como error |
| PST-100 | Test de contrato: la respuesta serializada no contiene tokens | BE | ⬜ Todo | PST-091 | Falla si aparece `accessToken`, `refreshToken`, `ciphertext`, `keyVersion` o un valor con forma de token |

---

## Orden de ejecución sugerido

```
Sprint 1  ── PST-003 · 004 · 005 · 006 · 010 · 011 · 013
             (fundaciones + login)            BE ██████  FE ███

Sprint 2  ── PST-020 · 021 · 022 · 023 · 030 · 031
             (cifrado + infra OAuth)          BE ██████  FE —
             En paralelo (OPS): PST-072 · 073 · 074 ← arrancar el día 1

Sprint 3  ── PST-032 · 033 · 034 · 071 · 090 · 091 · 092
             (las tres conexiones + apartado de configuración)
                                              BE █████   FE ███

Sprint 4  ── PST-040 · 041 · 042 · 043 · 044 · 045 · 046
             (contrato + orquestación)        BE ███████ FE —
             En paralelo: PST-055 · 056 contra el contrato ya cerrado

Sprint 5  ── PST-050 · 051 · 052 · 053 · 057 · 058 · 059
             (adaptadores + UI de resultado)  BE ████    FE ███
             En paralelo: PST-093 · 094 · 095 · 096 · 097 · 098 · 099 · 100
             (cierre del apartado de configuración)

Sprint 6  ── PST-054 · 060 · 061 · 062 · 063 · 064 · 080 · 081 · 082 · 083
             (endurecimiento + QA)            BE ███████ FE ██
```

**Punto de sincronización clave:** el contrato de PST-040 debe congelarse al inicio del Sprint 4. A partir de ahí, frontend y backend avanzan en paralelo contra el mismo esquema Zod sin bloquearse.

---

## Convención de actualización

1. Al abrir la rama: el ticket pasa a `🔄 In Progress`.
2. Al mergear a `main`: pasa a `✅ Done` **en el mismo PR** que el código.
3. La tabla de [Resumen de estado](#resumen-de-estado) se recalcula en el mismo commit.
4. Un ticket bloqueado por algo externo se marca `🚫 Blocked` con el motivo en la columna *Depende de*.
5. Nomenclatura de ramas: `feat/PST-043-publish-endpoint`, `fix/PST-053-meta-error-mapping`.
