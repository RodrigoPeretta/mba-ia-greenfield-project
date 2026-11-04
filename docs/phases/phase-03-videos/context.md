---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-15T20:24:58-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24T22:01:35-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-24T22:03:35-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-15T20:24:58-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-15T20:24:58-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-15T20:24:58-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-15T20:24:58-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-15T20:24:58-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _No subproject is named in the phase 03 section of project-plan.md._
**Deferred subprojects:** _None._
**Sequencing notes:** > Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública. (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | @nestjs/bullmq, bullmq |
|     └─ Last revision: 2026-10-24 — Broker image fixed as Valkey 8 (`valkey/valkey`, BSD-3, Redis-protocol compat… | | | | | | |
| phase-03-videos/TD-02 | phase | Cross-layer | Upload Protocol for Files up to 10GB | decided | B (S3 multipart with presigned part URLs, API-orchestrated) | — |
| phase-03-videos/TD-03 | phase | Cross-layer | Draft Pre-registration and Processing Trigger (Upload Handshake) | decided | A (Client-driven handshake through the API) | — |
| phase-03-videos/TD-04 | phase | Backend | Storage Organization (Buckets and Object Keys) | decided | A (Single private bucket, keys grouped by video id) | — |
| phase-03-videos/TD-05 | phase | Backend | Presigned URL Endpoint under Docker Networking | decided | A (Internal endpoint for server ops + public endpoint for signing) | — |
| phase-03-videos/TD-06 | phase | Backend | Video Worker Runtime and Deployment | decided | A (Same codebase, separate entrypoint + Compose service with FFmpeg) | — |
| phase-03-videos/TD-07 | phase | Backend | Media Probing and Thumbnail Generation Approach | decided | A (Native `ffprobe`/`ffmpeg` via `execFile`, reading a presigned URL) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Unique Video URL Identifier | decided | B (Random 11-char base64url + unique index + retry) | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Streaming and Download Delivery | decided | A (Presigned GET + native Range/206; `attachment` for download) | — |
|     └─ Last revision: 2026-10-24 — Phase 03 access rule for stream/download fixed: owner only (JWT guard + owners… | | | | | | |
| phase-03-videos/TD-10 | phase | Cross-layer | Video Status Model | decided | B (Processing-only enum `draft → processing → ready \| failed`; publication separate) | — |
| phase-03-videos/TD-11 | phase | Backend | Processing Failure, Retry and Orphan Handling | decided | A (Bounded retries, terminal `failed` with reason, idempotent job, reconciliation, cleanup of abandoned uploads) | — |
| phase-03-videos/TD-12 | phase | Backend | S3 Client Library for API and Worker | decided | A (AWS SDK v3, checksum `WHEN_REQUIRED`) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-12 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-06 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-05, phase-03-videos/TD-12 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-10 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-12 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-12 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-12 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** The phase has one job type with long execution, and BullMQ gives exactly the job semantics TD-11 needs (attempts, backoff, unrecoverable errors, deduplication by `jobId`, stalled detection) through an official Nest module, while adding a real queue container that matches the C4 diagram; the non-transactional enqueue is a known trade-off handled by idempotency and reconciliation in TD-11. pg-boss is the strongest alternative if avoiding a new service were a priority, which the challenge explicitly does not reward. Image choice (Redis 8 vs Valkey) is pinned in `library-refs.md` by `plan-resolve`.
**Libraries:** @nestjs/bullmq, bullmq

**Revisions:**
- 2026-10-24 — `**Libraries:**` filled with the packages of the decided option (`@nestjs/bullmq`, `bullmq`). Rationale: Libraries field filled from the decided option (validation IC-1).
- 2026-10-24 — Broker image fixed as Valkey 8 (`valkey/valkey`, BSD-3, Redis-protocol compatible) instead of Redis 8; exact tag pinned in `library-refs.md`. Rationale: avoids Redis 8's AGPLv3/RSAL/SSPL licensing with no API change for BullMQ (validation OQ-1).

### phase-03-videos/TD-02

**Recommendation:** It is the only option that both keeps the bytes off the API and exceeds the 5GB single-PUT ceiling, while giving part-level resume (Pontos de Atenção) on the storage that is already decided. Suggested parameters for the plan: max declared size `10 GiB` validated at initiation and re-checked with `HeadObject` at completion; fixed part size `64 MiB` (≈160 parts for 10GB, well under 10,000; above S3's 5 MiB minimum); part-URL expiry ~1h with re-signing on resume; accepted content types `video/*` (real validation is ffprobe, TD-07). Depends on TD-04/TD-05 for bucket and endpoint.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Keeps authorization, ownership, size validation and the `draft → processing` transition inside the API and the existing guard/filter stack, works identically on MinIO and S3, and is fully testable with the Compose infra; the "client never completes" gap is covered by TD-11. Depends on TD-01 (producer), TD-02 (multipart) and TD-10 (statuses).
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Minimal configuration surface for one bucket (env, bootstrap, CORS, lifecycle rule for incomplete multiparts from TD-11), immutable keys independent of user input and ownership, and a per-video prefix that scales to future renditions; per-bucket policies (B) bring no benefit in this phase since everything is served via presigned URLs (TD-09).
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** It is the only option that keeps bytes off the API, honors the Compose-service-name rule for container traffic, and needs no per-machine setup; the second config key mirrors the production split between internal and public S3 endpoints.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** It delivers the separate worker container the diagram and challenge require while reusing the single `Video` entity and the existing config/test infrastructure, keeping one Definition of Done pipeline; B's isolation is not worth the duplicated schema and tooling for one job type. Depends on TD-01 (BullMQ processor API).
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Avoids a deprecated wrapper and avoids copying 10GB per job, keeping worker disk usage constant; thumbnail policy suggestion for the plan: frame at ~10% of duration (clamped to a valid timestamp for very short videos), JPEG scaled to 1280px width. A file ffprobe cannot read as video is a non-retryable failure (TD-11). Depends on TD-05 (internal endpoint signing for the worker) and TD-06 (FFmpeg in the image).
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Meets "curta e única" with a database-enforced guarantee, is non-enumerable (important once Phase 04 adds unlisted videos reachable only by link), and needs no new library; generated at draft creation (TD-03) so the URL exists from the first response.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Satisfies streaming and download with zero bytes through the API, uses capabilities S3/MinIO already provide, and matches the C4 diagram; HLS (C) stays a future evolution that fits under the per-video prefix of TD-04. Only `ready` videos are streamable/downloadable; access rules by visibility (public/unlisted/anonymous) belong to Phases 04–05 and are set for this phase in the plan's Authorization Matrix. Depends on TD-04 and TD-05.
**Libraries:** —

**Revisions:**
- 2026-10-24 — Phase 03 access rule for stream/download fixed: owner only (JWT guard + ownership check; other callers get 404), and only for `ready` videos; Phase 04 publication/visibility reopens the rule for public/unlisted/anonymous access. Rationale: no publication exists in Phase 03, so every video is effectively unpublished (validation AMB-1).

### phase-03-videos/TD-10

**Recommendation:** Mirrors the challenge's lifecycle literally and keeps Phase 04's publication flow from overloading or migrating this enum; the naming ambiguity is cheap to document in the Data Model. Depends on TD-03 (who triggers each transition).
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** It covers transient and permanent failures, prevents duplicate jobs and bounds orphaned storage using only BullMQ and S3 built-ins; the manual reprocess endpoint (C) has no phase capability behind it and can be layered on later without changing the model. Errors in the worker are logged and never rethrown outside the job context (`.claude/rules/nestjs-services.md` → background tasks). Depends on TD-01, TD-04 and TD-10.
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** It is the only option where the whole TD-02 handshake (create, presign part, complete, abort) and TD-09's `attachment` download are public, typed operations, and its offline presigning fits TD-05's internal/public split with no extra configuration; the checksum default is a one-line, documented client setting (`WHEN_REQUIRED`) applied to both instances. Depends on TD-02, TD-04, TD-05 and TD-09.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and ... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 03 and then rerun /plan-context phase-03-videos to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Anticipated types not yet in the project (e.g., queue processors / workers) — see `artifacts/future-types.md` of the `testing-guide-nestjs-project` Skill._
