---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-16
scope_description: "Video upload and processing backend: queue technology, direct-to-storage 10GB upload protocol, storage layout and presigned-URL endpoints, video worker runtime and FFmpeg probing/thumbnail, unique video URL, streaming/download delivery, and video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the `videos` module (upload handshake, status, stream/download endpoints), the S3 client integration, the queue producer, the video worker entrypoint, the `videos` migration, and the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — no open decision in this document: the phase's capability bullets contain no screen, and the challenge statement puts the video UI out of scope. The Cross-layer TDs below (TD-02, TD-03, TD-08, TD-09, TD-10) fix the HTTP contract a future frontend consumer will follow; in this phase the e2e tests play the client role.

**Inherited constraints (not reopened):** object storage is S3-compatible, MinIO in local Docker (challenge statement + `docs/diagrams/software-arch.mermaid`); custom JWT guard with `@nestjs/jwt` (phase-02-auth/TD-02); `class-validator` DTOs (phase-02-auth/TD-06); domain exception filter (phase-02-auth/TD-07); `@nestjs/throttler` (phase-02-auth/TD-08); `@nestjs/config` + Joi + `registerAs` namespaces (phase-01-configuracao-base/TD-01..TD-04); `@nestjs/swagger` (openapi-docs-nestjs/TD-01). Compose service names are used as hosts (root `CLAUDE.md` → Docker Networking).

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and the C4 diagram leave the queue as `TBD`. It is the main stack decision of the phase: it defines a new Compose service (or none), the producer API used by the `videos` module, the consumer API used by the worker, and the retry/failure semantics that TD-11 builds on. Video jobs are few but long (minutes for a 10GB file), so lock/heartbeat handling matters more than throughput.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue. Nest's official integration offers `BullModule.forRoot/registerQueue`, `@InjectQueue` for producers and `@Processor` + `WorkerHost` for consumers. New Compose service: `redis` (or the wire-compatible Valkey image).
- **Pros:** Official Nest module (same pattern as the rest of the stack). Built-in `attempts` + exponential `backoff`, `UnrecoverableError` to skip retries, `jobId`/deduplication for idempotent enqueue, stalled-job detection with configurable `lockDuration` (fits long FFmpeg jobs). Large documentation base.
- **Cons:** One more infrastructure service (Redis). Enqueue is not transactional with the PostgreSQL write (dual-write between DB status and queue — mitigated in TD-11). Redis 8 is AGPLv3/RSAL/SSPL tri-licensed (Valkey is the BSD alternative, same protocol).

### Option B: pg-boss (queue on the existing PostgreSQL)
- Job queue implemented on PostgreSQL tables (`SKIP LOCKED`). Producer calls `boss.send()`, worker calls `boss.work()`. No new service; jobs live in a `pgboss` schema of the `db` container.
- **Pros:** Zero new infrastructure. Enqueue can share the DB connection, getting closer to transactional "insert video + enqueue". `retryLimit`/`retryBackoff`, `deadLetter` queues and `singletonKey` built in.
- **Cons:** No official Nest module — a custom provider/lifecycle wrapper is needed. Polling-based delivery. The challenge requires "fila, worker e storage reais subindo no Compose"; a queue living inside `db` makes the "queue as a container" evidence weaker, and it diverges from the C4 diagram, which models the queue as its own container.

### Option C: RabbitMQ (AMQP)
- Dedicated message broker; Nest integrates via `@nestjs/microservices` (RMQ transport) or `amqplib`. New Compose service `rabbitmq`.
- **Pros:** True message broker with routing, DLX (dead-letter exchanges), management UI. Language-agnostic consumers.
- **Cons:** It is a broker, not a job queue: retries with backoff, job state and deduplication must be built by hand (DLX + TTL tricks). The Nest microservices transport is request/event oriented, with less control over ack/prefetch for long jobs. More configuration for a single job type.

**Recommendation:** **Option A (BullMQ + Redis)** — the phase has one job type with long execution, and BullMQ gives exactly the job semantics TD-11 needs (attempts, backoff, unrecoverable errors, deduplication by `jobId`, stalled detection) through an official Nest module, while adding a real queue container that matches the C4 diagram; the non-transactional enqueue is a known trade-off handled by idempotency and reconciliation in TD-11. pg-boss is the strongest alternative if avoiding a new service were a priority, which the challenge explicitly does not reward. Image choice (Redis 8 vs Valkey) is pinned in `library-refs.md` by `plan-resolve`.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-02: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The video bytes must not pass through the API (challenge: "sem segurar a API durante o envio"; automatic failure if the 10GB file goes through the API). `docs/project-plan.md` § Pontos de Atenção also asks that the upload "permita retomar em caso de falha de conexão". A single S3 `PUT` is capped at 5GB, so 10GB requires multipart. Both sides are affected: the backend exposes the handshake; the client (future frontend, e2e tests now) uploads the parts.

**Options:**

### Option A: Single presigned `PUT` URL
- API returns one presigned `PutObject` URL; client uploads the whole file in one request.
- **Pros:** Simplest contract (one URL, one request). No server-side state.
- **Cons:** S3 single-PUT limit is 5GB — cannot meet 10GB. No resume: a dropped connection restarts from zero.

### Option B: S3 multipart upload with presigned part URLs, orchestrated by the API
- API calls `CreateMultipartUpload`, returns `uploadId` + presigned `UploadPart` URLs (fixed part size); client `PUT`s each part directly to storage and collects the `ETag`s; API calls `CompleteMultipartUpload` (or `AbortMultipartUpload`). Resume: client asks the API for the parts already stored (`ListParts`) and re-sends only the missing ones.
- **Pros:** Bytes go straight to storage — the API only signs URLs. Supports objects up to 5TB (10,000 parts × up to 5GiB). Part-level resume and parallelism. Standard S3 API, works identically on MinIO and AWS S3 with `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.
- **Cons:** Multi-step handshake (initiate → sign parts → complete). Browser clients need bucket CORS exposing the `ETag` header. Abandoned uploads leave incomplete parts (cleanup in TD-11).

### Option C: tus resumable protocol (`@tus/server` with S3 store, or a `tusd` container)
- Client speaks tus (`tus-js-client`); a tus server receives chunks and writes them to S3 via multipart.
- **Pros:** Standardized resumable protocol with mature clients.
- **Cons:** With `@tus/server` inside Nest, every byte flows through the API — exactly what the challenge forbids. With a separate `tusd` container, bytes still traverse an extra service and auth/hooks to create the draft must be wired via tusd hooks. Extra moving part for something S3 multipart already provides.

**Recommendation:** **Option B (presigned multipart, API-orchestrated)** — it is the only option that both keeps the bytes off the API and exceeds the 5GB single-PUT ceiling, while giving part-level resume (Pontos de Atenção) on the storage that is already decided. Suggested parameters for the plan: max declared size `10 GiB` validated at initiation and re-checked with `HeadObject` at completion; fixed part size `64 MiB` (≈160 parts for 10GB, well under 10,000; above S3's 5 MiB minimum); part-URL expiry ~1h with re-signing on resume; accepted content types `video/*` (real validation is ffprobe, TD-07). Depends on TD-04/TD-05 for bucket and endpoint.

**Decision:** B (S3 multipart with presigned part URLs, API-orchestrated)

---

## TD-03: Draft Pre-registration and Processing Trigger (Upload Handshake)

**Scope:** Cross-layer

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The draft must exist as soon as the upload starts, and processing must start automatically once the upload finishes. Since bytes bypass the API (TD-02), someone must tell the system the upload is done. This defines the endpoints the client calls and who enqueues the job.

**Options:**

### Option A: Client-driven handshake through the API
- `POST /videos` (authenticated) creates the `videos` row as draft (owner = caller's channel), calls `CreateMultipartUpload` and returns the video id + upload info. After uploading parts, the client calls a completion endpoint; the API runs `CompleteMultipartUpload`, verifies the object (`HeadObject` size ≤ limit), moves the video to `processing` and enqueues the job. An abort endpoint cancels the multipart and discards the draft.
- **Pros:** Single, explicit flow owned by the API (auth, ownership, size validation and state transition in one place). Portable — no storage-specific eventing. Easy to test end-to-end with supertest + real MinIO.
- **Cons:** If the client never calls "complete", the upload stays as draft (handled by TD-11 cleanup). One extra request per upload.

### Option B: Storage event notification triggers processing
- Client completes the multipart directly on storage; MinIO bucket notification (`s3:ObjectCreated:CompleteMultipartUpload`) is sent to a webhook on the API (or to a broker target), which then enqueues the job.
- **Pros:** Processing starts even if the client disappears after the last part. No "complete" endpoint.
- **Cons:** Notification configuration differs between MinIO (webhook/AMQP/Redis targets via `mc`/env) and AWS S3 (SQS/SNS/EventBridge) — breaks "MinIO now, S3 in production" portability. Size validation happens only after the object is stored. Needs a webhook auth mechanism and at-least-once/duplicate handling. MinIO's Redis target payload is not a BullMQ job, so a bridge is still needed.

**Recommendation:** **Option A (client-driven handshake)** — keeps authorization, ownership, size validation and the `draft → processing` transition inside the API and the existing guard/filter stack, works identically on MinIO and S3, and is fully testable with the Compose infra; the "client never completes" gap is covered by TD-11. Depends on TD-01 (producer), TD-02 (multipart) and TD-10 (statuses).

**Decision:** A (Client-driven handshake through the API)

---

## TD-04: Storage Organization (Buckets and Object Keys)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage product is decided (S3/MinIO); how it is organized is not. The bucket name(s) are a cross-component contract (env schema + `compose.yaml` bucket bootstrap + API + worker), and the key format is persisted in the `videos` table (storage keys for file and thumbnail, per the challenge). Pontos de Atenção ask to plan storage growth/costs from the start.

**Options:**

### Option A: Single private bucket, keys grouped by video id
- One bucket (e.g. `streamtube-media`), keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. All access through presigned URLs.
- **Pros:** One bucket to bootstrap, configure CORS and lifecycle on. All artifacts of a video share a prefix — deleting a video is "delete prefix"; future renditions (HLS, multiple thumbnails) fit under the same prefix. Keys never derive from user input (original filename stays in DB metadata) — no path injection or collisions.
- **Cons:** Different retention/access policies for videos vs thumbnails must be expressed per prefix instead of per bucket.

### Option B: Separate buckets per artifact type (`videos` and `thumbnails`)
- Originals in one bucket, thumbnails in another; keys `{videoId}.{ext}` / `{videoId}.jpg`.
- **Pros:** Policies per bucket (e.g. public-read thumbnails later, lifecycle on raw videos only). Simple cost accounting per artifact type.
- **Cons:** Two buckets in env, bootstrap and CORS. Deleting a video touches two places. More config keys to keep consistent.

### Option C: Keys grouped by channel (`channels/{channelId}/videos/{videoId}/...`)
- Same as A or B but with channel prefix.
- **Pros:** Per-channel usage listing directly from storage.
- **Cons:** Couples storage layout to ownership; a future ownership change or channel merge would require moving objects. Usage per channel is easier from the DB (`size` metadata) anyway.

**Recommendation:** **Option A (single private bucket, `videos/{videoId}/...`)** — minimal configuration surface for one bucket (env, bootstrap, CORS, lifecycle rule for incomplete multiparts from TD-11), immutable keys independent of user input and ownership, and a per-video prefix that scales to future renditions; per-bucket policies (B) bring no benefit in this phase since everything is served via presigned URLs (TD-09).

**Decision:** A (Single private bucket, keys grouped by video id)

**Note:** the `minio/minio` and `minio/mc` images were removed from Docker Hub (Sep 2026) and quay.io now requires authentication — verified with `docker pull` on 2026-10-16. The MinIO server keeps being used through the free Chainguard build: `cgr.dev/chainguard/minio` (same MinIO, `RELEASE.2026-09-22`) and `cgr.dev/chainguard/minio-client` for bucket bootstrap. Verified locally: the image is distroless (no shell — bootstrap must call `mc` directly, e.g. with `MC_HOST_<alias>`) and runs as uid 65532, so a named volume needs `user: "0"` (or pre-chowned storage) or the server aborts with `file access denied`. Exact tags are pinned in `library-refs.md` by `plan-resolve`.

---

## TD-05: Presigned URL Endpoint under Docker Networking

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Containers reach MinIO at the Compose service name (`http://minio:9000`, per root `CLAUDE.md`), but presigned URLs are consumed by clients outside the Compose network (browser, host-side tests/tools), which cannot resolve `minio`. A SigV4 signature includes the `Host`, so a URL signed for `minio:9000` cannot simply be rewritten to `localhost:9000`. This is a cross-component contract: env schema + `compose.yaml` + S3 client configuration (`forcePathStyle` for MinIO).

**Options:**

### Option A: Two endpoints — internal for server operations, public for signing
- `S3_ENDPOINT=http://minio:9000` for API/worker operations (multipart create/complete, `HeadObject`, worker reads/writes); `S3_PUBLIC_ENDPOINT` (dev: `http://localhost:9000`; prod: the public S3/CDN host) used by a dedicated client only for presigning URLs handed to clients.
- **Pros:** Signatures are valid for the host the client actually calls. Server-to-storage traffic keeps using the Compose service name. Maps 1:1 to production (internal VPC endpoint vs public endpoint).
- **Cons:** Two client instances/config keys. The `localhost` value in `S3_PUBLIC_ENDPOINT` must be documented as client-facing (not a container-to-container host) so it does not look like a violation of the Docker Networking rule.

### Option B: Proxy storage through the API (or an extra reverse proxy) on a single public host
- Clients only talk to the API/proxy host, which forwards to `minio:9000`.
- **Pros:** One public host; storage never exposed.
- **Cons:** If the API proxies, upload/stream bytes go through it — contradicts TD-02's goal. Adding nginx just for host rewriting is an extra service with signature-forwarding pitfalls.

### Option C: Single endpoint name resolvable everywhere
- Use one hostname for both sides (e.g. add `minio` to the host's `hosts` file, or `host.docker.internal` from containers).
- **Pros:** One client, one config key.
- **Cons:** Requires per-machine manual setup (hosts file) or platform-specific DNS (`host.docker.internal` behaves differently on Linux); fragile for whoever clones the repo and for CI.

**Recommendation:** **Option A (internal + public endpoints)** — it is the only option that keeps bytes off the API, honors the Compose-service-name rule for container traffic, and needs no per-machine setup; the second config key mirrors the production split between internal and public S3 endpoints.

**Decision:** A (Internal endpoint for server operations + public endpoint for signing)

**Note:** the e2e/integration suites run inside the `nestjs-api` container, where `localhost:9000` is the container itself, and SigV4 signs the `Host` — so a URL signed for `localhost` cannot be used by the tests. In the test environment `S3_PUBLIC_ENDPOINT` points to the Compose service (`http://minio:9000`): there the client lives inside the Compose network. `localhost:9000` remains the dev value for host-side clients (browser/tools).

---

## TD-06: Video Worker Runtime and Deployment

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The C4 diagram models the Video Worker as its own container (FFmpeg) that reads/writes storage and updates the DB. FFmpeg work is CPU/IO heavy and must not compete with the API ("sem impacto na performance"). The choice defines the Compose service, the image (FFmpeg installed), and how the worker reuses the `Video` entity/TypeORM config.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint, separate Compose service
- A second bootstrap (e.g. `NestFactory.createApplicationContext(WorkerModule)`, no HTTP server) registers the `@Processor` only there. Compose adds a `video-worker` service built from the same Dockerfile (with `ffmpeg` installed via apt) running the worker entrypoint; the API never registers the processor.
- **Pros:** Reuses entities, repositories, config namespaces, Joi validation and the test setup — one `Video` entity, no drift. Separate process/container isolates CPU and can be scaled independently (`docker compose up --scale video-worker=N`). FFmpeg in the shared dev image also lets integration tests run inside `nestjs-api` against the real binaries.
- **Cons:** API image also carries FFmpeg (bigger dev image). Discipline needed so worker-only providers are not imported into `AppModule`.

### Option B: Separate subproject (`video-worker/` with its own `package.json`)
- Independent Node (or other language) project consuming the queue and talking to DB/storage directly.
- **Pros:** Strong isolation; minimal image for the worker; could be written in another language.
- **Cons:** Duplicates entity/schema knowledge (or requires a shared package → monorepo tooling decision outside this phase). Second lint/test/tsc pipeline to satisfy the Definition of Done. BullMQ job contract maintained in two places.

### Option C: Processor inside the API process
- `@Processor` registered in the API's `AppModule`; jobs run in the same Node process as HTTP.
- **Pros:** Zero extra service; simplest wiring.
- **Cons:** FFmpeg child processes and I/O share the API container's CPU — violates "sem impacto na performance" and the C4 diagram (worker as separate container); scaling API and worker is coupled.

**Recommendation:** **Option A (same codebase, separate entrypoint and container)** — it delivers the separate worker container the diagram and challenge require while reusing the single `Video` entity and the existing config/test infrastructure, keeping one Definition of Done pipeline; B's isolation is not worth the duplicated schema and tooling for one job type. Depends on TD-01 (BullMQ processor API).

**Decision:** A (Same codebase, separate entrypoint and Compose service with FFmpeg)

---

## TD-07: Media Probing and Thumbnail Generation Approach

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration/metadata and generate a thumbnail from a frame. Two coupled choices: how FFmpeg is invoked from Node, and how it reads a source that can be 10GB (download first vs read remotely).

**Options:**

### Option A: Native `ffprobe`/`ffmpeg` via `child_process.execFile`, reading the source through a presigned GET URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>` → parse JSON (duration, codecs, resolution, bitrate, size). `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=… thumbnail.jpg` → upload to `videos/{id}/thumbnail.jpg`. FFmpeg's HTTP input issues Range requests, so only the header/index and the target frame region are read — no full 10GB copy.
- **Pros:** No wrapper dependency; typed parsing of ffprobe's JSON is small. Constant disk usage regardless of video size; fast. Same binaries in dev, tests and prod (apt package in the image, TD-06).
- **Cons:** Hand-written argument building and error mapping (exit code + stderr). For files whose index (`moov`) is at the end, ffprobe performs extra range seeks (still far cheaper than a full download).

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API over the same binaries (`ffprobe()`, `screenshots()`).
- **Pros:** Convenient API, lots of examples.
- **Cons:** The npm package is marked deprecated/unmaintained by its author — a poor dependency to introduce in a new phase. Adds callback-style API to wrap in promises.

### Option C: Download the object to local temp storage, then run FFmpeg on the file
- Worker streams `GetObject` to a temp volume, probes and extracts the frame locally, deletes the file.
- **Pros:** Local file access is the most robust input for FFmpeg (any container layout).
- **Cons:** 10GB of disk and network per job, minutes of extra latency, temp-volume sizing and cleanup on crash.

**Recommendation:** **Option A (native binaries via `execFile`, remote presigned input)** — avoids a deprecated wrapper and avoids copying 10GB per job, keeping worker disk usage constant; thumbnail policy suggestion for the plan: frame at ~10% of duration (clamped to a valid timestamp for very short videos), JPEG scaled to 1280px width. A file ffprobe cannot read as video is a non-retryable failure (TD-11). Depends on TD-05 (internal endpoint signing for the worker) and TD-06 (FFmpeg in the image).

**Decision:** A (Native `ffprobe`/`ffmpeg` via `execFile`, reading a presigned URL)

---

## TD-08: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a URL that never conflicts with another; Pontos de Atenção ask for a **short** and unique URL. The identifier is persisted (unique column), returned by the API and used by the frontend routes (Phase 05 watch page) — a contract on both sides.

**Options:**

### Option A: Use the UUID primary key in the URL
- `/videos/3f0c…-…` — the row id is the public identifier.
- **Pros:** Zero extra column; global uniqueness without checks.
- **Cons:** 36 characters — not "short"; exposes the internal PK.

### Option B: Random short id (11-char base64url) with unique index and retry
- Generate 8 random bytes with `crypto.randomBytes` → 11-char base64url (64 bits, YouTube-like). Store in a `slug`/`public_id` column with a unique index; on unique violation (`23505`) regenerate.
- **Pros:** Short and opaque (not enumerable, reveals nothing). No new dependency (Node `crypto`). Collision probability negligible, and the DB constraint makes "never conflicts" a guarantee rather than a probability. Same pattern the project already uses for the random nickname fallback (phase-02-auth/TD-10).
- **Cons:** Extra column + index. Retry must follow the project rule for constraint violations inside transactions (`.claude/rules/typeorm-queries.md` — aborted transaction state).

### Option C: Encoded sequential id (Sqids/Hashids)
- Encode an auto-increment number into a short string.
- **Pros:** Very short; no collision by construction.
- **Cons:** Reversible/enumerable (reveals volume and allows scraping unlisted videos of Phase 04); requires a sequence beside the UUID PK and a new dependency.

**Recommendation:** **Option B (random 11-char base64url + unique index)** — meets "curta e única" with a database-enforced guarantee, is non-enumerable (important once Phase 04 adds unlisted videos reachable only by link), and needs no new library; generated at draft creation (TD-03) so the URL exists from the first response.

**Decision:** B (Random 11-char base64url + unique index + retry)

---

## TD-09: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, and the user must be able to download it. The C4 diagram already draws `Frontend → Object Storage: "Streams"`. The choice defines the API endpoints and what the frontend player/download button receive.

**Options:**

### Option A: API authorizes and hands out presigned GET URLs; storage serves Range/206
- Stream endpoint returns (or `302`-redirects to) a presigned `GetObject` URL; the storage answers `Range` requests with `206 Partial Content`, so the `<video>` element seeks natively. Download endpoint returns a presigned URL with `ResponseContentDisposition: attachment; filename="…"`. The API only checks status/authorization and signs.
- **Pros:** Zero video bytes through the API (same principle as upload). Range/206 support is native in S3/MinIO. Matches the C4 diagram. Download is the same mechanism with a different response header.
- **Cons:** URL expiry must cover a viewing session (each Range request re-validates the signature) — needs a TTL policy (e.g. a few hours) and re-fetch by the player on expiry. Progressive MP4 with `moov` at the end needs an extra initial range request before playback.

### Option B: API proxies the stream (Range → `GetObject` with Range → pipe 206)
- Nest endpoint parses `Range`, requests the same range from storage and pipes it back with `206`, `Content-Range`, `Accept-Ranges`.
- **Pros:** Storage stays fully private; stable URLs without expiry; per-request authorization/metrics.
- **Cons:** Every byte watched passes through the API — the bandwidth/CPU impact the phase is designed to avoid; Range parsing/edge cases (multi-range, suffix ranges) implemented by hand.

### Option C: Adaptive streaming (HLS/DASH) produced by the worker
- Worker transcodes into segments + manifest; player uses `hls.js`.
- **Pros:** Adaptive bitrate, the "real YouTube" model.
- **Cons:** Full transcode of up to 10GB per video (hours of CPU), multiple renditions in storage (cost — Pontos de Atenção), a player library on the frontend. Exceeds the phase capability ("sem necessidade de download completo" is met by Range requests).

**Recommendation:** **Option A (presigned GET + native Range/206)** — satisfies streaming and download with zero bytes through the API, uses capabilities S3/MinIO already provide, and matches the C4 diagram; HLS (C) stays a future evolution that fits under the per-video prefix of TD-04. Only `ready` videos are streamable/downloadable; access rules by visibility (public/unlisted/anonymous) belong to Phases 04–05 and are set for this phase in the plan's Authorization Matrix. Depends on TD-04 and TD-05.

**Decision:** A (Presigned GET + native Range/206; `attachment` disposition for download)

---

## TD-10: Video Status Model

**Scope:** Cross-layer

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The challenge expects the cycle `rascunho → processando → pronto/erro` reflected in the DB. Phase 04 adds a separate "rascunho → publicação" flow and visibility. The status values are persisted (enum + migration), written by API and worker, and returned to clients — so whether processing and publication share one field must be decided now to avoid a Phase 04 migration that reinterprets values.

**Options:**

### Option A: Single `status` enum covering upload, processing and publication
- e.g. `draft | processing | ready | failed | published`.
- **Pros:** One column, one filter.
- **Cons:** Mixes two independent axes: a `ready` video can be unpublished or published, a published video could need reprocessing. Phase 04 would have to overload values or migrate. Invalid combinations become representable.

### Option B: Processing status enum now; publication as a separate field in Phase 04
- `status`: `draft` (row created, upload in progress) → `processing` (upload completed, job enqueued) → `ready` | `failed`. Transitions enforced in the service (only `draft→processing`, `processing→ready|failed`). Phase 04 adds its own publication/visibility fields without touching this enum.
- **Pros:** Exactly the cycle the challenge describes; each axis evolves independently; transition guards make illegal moves (e.g. `ready→draft`) explicit domain errors. Worker writes only `ready|failed` + metadata.
- **Cons:** Phase 04 must remember that "draft" in publication terms is a different concept from `status = draft` (naming to be clarified in the plan's Data Model).

**Recommendation:** **Option B (processing-only status enum, publication separate)** — mirrors the challenge's lifecycle literally and keeps Phase 04's publication flow from overloading or migrating this enum; the naming ambiguity is cheap to document in the Data Model. Depends on TD-03 (who triggers each transition).

**Decision:** B (Processing-only status enum `draft → processing → ready | failed`; publication separate)

---

## TD-11: Processing Failure, Retry and Orphan Handling

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The challenge asks what happens when processing fails. Failures can be transient (storage/DB unavailable, worker restart mid-job) or permanent (file is not a valid video). There are also two orphan cases: drafts whose upload was never completed (incomplete multipart parts consume storage), and videos stuck in `processing` because the enqueue after the DB commit failed (dual-write, TD-01).

**Options:**

### Option A: Bounded automatic retries, then terminal `failed` with reason; idempotent job; storage lifecycle for abandoned uploads
- Job enqueued with `jobId = videoId` (dedup), `attempts: 3`, exponential `backoff`. Worker is idempotent (re-running overwrites the same thumbnail key and metadata). Invalid media → `UnrecoverableError` (no retry). On final failure the worker sets `status = failed` + `failure_reason`; owner can delete/re-upload. Enqueue happens after the DB transition commits; a startup/periodic reconciliation re-enqueues `processing` videos without a live job. Bucket lifecycle rule `AbortIncompleteMultipartUpload` (e.g. 1–2 days) cleans abandoned parts.
- **Pros:** Transient errors self-heal; permanent errors fail fast with a visible reason; no duplicate processing; bounded storage waste. All built-in BullMQ/S3 features (TD-01, TD-04).
- **Cons:** Reconciliation is extra code; draft rows of abandoned uploads remain in the DB (visible as `draft`, cleanup of rows left to a later phase or a scheduled job).

### Option B: No automatic retry — first failure marks `failed`
- Any error moves the video to `failed`; user re-uploads.
- **Pros:** Simplest; no idempotency concerns.
- **Cons:** A transient blip (MinIO restart, DB failover) forces a user to re-send up to 10GB. Poor UX for the most expensive operation of the platform.

### Option C: Option A plus a manual "reprocess" endpoint for `failed` videos
- Same as A, with an owner-triggered endpoint that moves `failed → processing` and re-enqueues.
- **Pros:** Recovers videos that failed after a long outage without re-upload.
- **Cons:** New endpoint and transition outside the phase's capability list (extrapolation for Phase 03); can be added later without changing A.

**Recommendation:** **Option A** — it covers transient and permanent failures, prevents duplicate jobs and bounds orphaned storage using only BullMQ and S3 built-ins; the manual reprocess endpoint (C) has no phase capability behind it and can be layered on later without changing the model. Errors in the worker are logged and never rethrown outside the job context (`.claude/rules/nestjs-services.md` → background tasks). Depends on TD-01, TD-04 and TD-10.

**Decision:** A (Bounded retries, terminal `failed` with reason, idempotent job, reconciliation, storage cleanup of abandoned uploads)

**Note:** MinIO rejects the `AbortIncompleteMultipartUpload` lifecycle rule (`mc ilm import` → "The XML you provided was not well-formed or did not validate", verified 2026-10-16); instead it cleans stale multipart uploads natively (`stale_uploads_expiry=24h`, `stale_uploads_cleanup_interval=6h`, configurable via `MINIO_API_STALE_UPLOADS_EXPIRY` / `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL`). Abandoned-part cleanup therefore relies on that native setting in dev (MinIO) and on the `AbortIncompleteMultipartUpload` lifecycle rule in production (AWS S3).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message queue technology | **A** (BullMQ + Redis via `@nestjs/bullmq`) | A |
| TD-02 | Cross-layer | Upload protocol for files up to 10GB | **B** (S3 multipart with presigned part URLs, API-orchestrated) | B |
| TD-03 | Cross-layer | Draft pre-registration and processing trigger | **A** (client-driven handshake: create draft → upload parts → complete → enqueue) | A |
| TD-04 | Backend | Storage organization (buckets and keys) | **A** (single private bucket, `videos/{videoId}/...`) | A |
| TD-05 | Backend | Presigned URL endpoint under Docker networking | **A** (internal endpoint for server ops + public endpoint for signing) | A |
| TD-06 | Backend | Video worker runtime and deployment | **A** (same codebase, separate entrypoint and Compose service with FFmpeg) | A |
| TD-07 | Backend | Media probing and thumbnail generation | **A** (native `ffprobe`/`ffmpeg` via `execFile`, reading a presigned URL) | A |
| TD-08 | Cross-layer | Unique video URL identifier | **B** (random 11-char base64url + unique index + retry) | B |
| TD-09 | Cross-layer | Streaming and download delivery | **A** (presigned GET + native Range/206; `attachment` disposition for download) | A |
| TD-10 | Cross-layer | Video status model | **B** (`draft → processing → ready \| failed`; publication separate in Phase 04) | B |
| TD-11 | Backend | Processing failure, retry and orphan handling | **A** (3 attempts + backoff, `UnrecoverableError`, `failed` + reason, dedup by `jobId`, reconciliation, multipart lifecycle rule) | A |
