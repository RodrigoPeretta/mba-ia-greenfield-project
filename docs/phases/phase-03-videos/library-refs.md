---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-24T22:03:04-03:00"
  "bullmq":
    version: "^6.4.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-24T22:03:04-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1156.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-24T22:03:04-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1156.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-24T22:03:04-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24T22:01:35-03:00"
---

# Library References — phase-03-videos

Distilled from Context7 (official sources) for the surfaces this phase uses. Versions are the latest published on npm at fetch time; `@nestjs/bullmq@12` peer-depends on `@nestjs/common|core ^10 || ^11 || ^12` and `bullmq ^3–^6`, compatible with the installed NestJS 11.

### @nestjs/bullmq

_Used by: phase-03-videos/TD-01 (producer in the API), TD-06 (processor in the worker entrypoint)._

- **Shared connection — async config:** `BullModule.forRootAsync({ imports, useFactory: (cfg) => ({ connection: { host, port } }), inject: [queueConfig.KEY] })` — registers a global module; fits the project's `registerAs` + `ConfigType` convention (inject the namespace KEY instead of `ConfigService`). Host comes from env and must be the Compose service name (e.g. `QUEUE_HOST=valkey`).
- **Queue registration:** `BullModule.registerQueue({ name: 'video-processing' })` in the module that produces or consumes; producer injects with `@InjectQueue('video-processing') queue: Queue`.
- **Consumer:** `@Processor('video-processing', { concurrency, lockDuration })` on a class that `extends WorkerHost` and implements `async process(job: Job<T>)`. The second argument takes raw BullMQ `WorkerOptions` (`concurrency`, `limiter`, `lockDuration`, …) — the place to raise `lockDuration` for long FFmpeg jobs (TD-01 context).
- **Errors:** a queue referencing a `configKey` never registered via `forRoot`/`forRootAsync` throws `MissingBullSharedConfigurationError` at instantiation — a module-compilation test catches it.

### bullmq

_Used by: phase-03-videos/TD-01, TD-11 (retry/failure semantics)._

- **Retries with backoff:** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } })` → retries after `2^(attempts-1) * delay` ms; optional `jitter` (0–1).
- **Stop retrying:** `throw new UnrecoverableError('…')` (import from `bullmq`) inside the processor moves the job straight to failed, overriding `attempts` — use for media ffprobe cannot read (TD-07/TD-11).
- **Idempotent enqueue:** `jobId: videoId` — jobs with an existing `jobId` are not added again. Caveat: with `removeOnComplete` / `removeOnFail`, a removed job no longer counts as existing, so the same `jobId` can be enqueued again (relevant to TD-11's reconciliation). Alternative: `deduplication: { id }` ignores new jobs while the existing one is not completed/failed.
- **Events:** `worker.on('failed', (job, err) => …)` / `'completed'` — in Nest, `@OnWorkerEvent('failed')` on the `WorkerHost` class; the final-attempt handler is where the video moves to `failed` + `failure_reason` (TD-11).

### @aws-sdk/client-s3

_Used by: phase-03-videos/TD-12 (library), TD-02, TD-04, TD-05, TD-07, TD-09, TD-11._

- **Client per endpoint (TD-05):** `new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })`. One instance with `S3_ENDPOINT` (operations), one with `S3_PUBLIC_ENDPOINT` (presigning only). `forcePathStyle: true` puts the bucket in the path (`host/bucket/key`), required by MinIO.
- **Checksum default (decision note in TD-12):** the S3 client defaults to `requestChecksumCalculation: WHEN_SUPPORTED`, which adds `x-amz-sdk-checksum-algorithm` + CRC32 headers to operations with a modeled checksum member (e.g. `PutObject`, `UploadPart`); `WHEN_REQUIRED` only adds them when the operation requires it or `ChecksumAlgorithm` is set explicitly.
- **Multipart (TD-02/TD-03):** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; client uploads parts; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`; `AbortMultipartUploadCommand` on cancel; `ListPartsCommand` to recover uploaded parts on resume. Each part response must carry an `ETag` — for browser uploads the bucket CORS must expose the `ETag` header, otherwise the client cannot complete.
- **Completion check (TD-02):** `HeadObjectCommand({ Bucket, Key })` → `ContentLength` to re-check the 10 GiB limit.
- **Download disposition (TD-09):** `GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"' })` — response-header overrides only work on signed requests (presigned URL).
- **Thumbnail upload (TD-07):** `PutObjectCommand({ Bucket, Key, Body, ContentType: 'image/jpeg' })` from the worker via the internal-endpoint client.

### @aws-sdk/s3-request-presigner

_Used by: phase-03-videos/TD-02 (part URLs), TD-07 (worker read URL), TD-09 (stream/download URLs)._

- `getSignedUrl(client, command, { expiresIn })` — presigns any command; `expiresIn` defaults to 900 s. Signing is local (SigV4), no network call — the public-endpoint client never contacts `localhost` from inside a container.
- **Part URLs:** `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 })`.
- **Signed `x-amz-*` headers:** to force headers such as `x-amz-checksum-sha256` into the signature, pass them in `unhoistableHeaders: new Set([...])`; `signableHeaders` / `unsignableHeaders` control the rest.

### Infrastructure images (pinned here per TD-01 / TD-04 notes)

| Service | Image | Source |
|---------|-------|--------|
| Queue broker (TD-01, revision 2026-10-24) | `valkey/valkey:8.1-alpine` | Docker Hub; tag verified with `docker manifest inspect` on 2026-10-24 |
| Object storage (TD-04 note) | `cgr.dev/chainguard/minio` | Chainguard free build (`RELEASE.2026-09-22`, per TD-04 note); local image is `:latest` — pin a digest in Compose |
| Bucket bootstrap (TD-04 note) | `cgr.dev/chainguard/minio-client` | Chainguard free build; distroless — call `mc` directly with `MC_HOST_<alias>` |
