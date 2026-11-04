---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-24T22:03:36-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-24T22:03:35-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24T22:01:35-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB sem impacto na performance da API (multipart direto para o armazenamento de arquivos), com pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático em segundo plano via fila (extração de duração e metadados e geração de thumbnail a partir de um frame), URL única por vídeo sem conflito com outros vídeos, e reprodução via streaming e download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: broker de fila, object storage e FFmpeg no ambiente Docker

**Description:** Sobe os containers de infraestrutura que a fase exige (broker Valkey e storage MinIO com bucket inicializado) e instala o FFmpeg na imagem compartilhada por API e worker, antes de qualquer código de domínio.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `valkey` com a imagem `valkey/valkey:8.1-alpine`, `command: valkey-server --maxmemory-policy noeviction` (política exigida pelo BullMQ: jobs nunca podem ser despejados da memória), porta `6379` e healthcheck `valkey-cli ping` (per `phase-03-videos/TD-01`; tag de `library-refs.md`)
2. Adicionar o serviço `minio` com `cgr.dev/chainguard/minio` fixado por digest, portas `9000` (API) e `9001` (console), credenciais via `.env` e healthcheck. Configurar a liberação de CORS para as origens do frontend expondo `ETag` e a expiração de multiparts incompletos após 1 dia, conferindo na documentação oficial do MinIO o mecanismo suportado (variáveis `MINIO_API_*` × regra `mc ilm`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`)
3. Adicionar o serviço one-shot `minio-init` (`cgr.dev/chainguard/minio-client`, `mc` com `MC_HOST_<alias>`) que cria o bucket `S3_BUCKET` de forma idempotente e privada, dependente de `minio` saudável (per `phase-03-videos/TD-04`)
4. Instalar `ffmpeg` (inclui `ffprobe`) em `nestjs-project/Dockerfile.dev` (`apt install -y ffmpeg`), porque a mesma imagem serve à API (testes de mídia) e ao worker (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
5. Fazer `nestjs-api` depender de `valkey` (healthy) e `minio-init` (completed successfully) e acrescentar ao `.env.example` as variáveis da § Configuração com valores de desenvolvimento, usando o nome do serviço Compose como host (`S3_ENDPOINT=http://minio:9000`, `QUEUE_HOST=valkey`); `S3_PUBLIC_ENDPOINT=http://localhost:9000` é o endpoint do navegador (per `phase-03-videos/TD-05`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `db`, `valkey` e `minio` em estado `healthy` e `minio-init` encerrado com código 0
- `docker compose exec valkey valkey-cli ping` responde `PONG`
- `docker compose exec valkey valkey-cli config get maxmemory-policy` retorna `noeviction`
- Depois do bootstrap, o bucket `S3_BUCKET` existe e uma requisição anônima a `http://localhost:9000/{bucket}/qualquer` recebe `403 AccessDenied`
- Rodar `minio-init` uma segunda vez encerra com código 0, sem erro de bucket já existente
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` imprimem a versão

---

### SI-03.2 — Configuração e StorageModule (clientes S3 interno/público)

**Description:** Cria os namespaces de configuração da fase e o módulo de storage que encapsula as operações S3 usadas pela API e pelo worker, para que nenhum outro módulo fale direto com o SDK.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (versões de `library-refs.md`) e criar `src/config/storage.config.ts`, `src/config/queue.config.ts` e `src/config/videos.config.ts` com `registerAs`, conforme a tabela § Configuração (per `phase-03-videos/TD-12`, `phase-01-configuracao-base/TD-03`)
2. Estender `src/config/env.validation.ts` com as novas variáveis (`S3_ACCESS_KEY` e `S3_SECRET_KEY` required; demais com os defaults da tabela) e carregar os três namespaces no `ConfigModule.forRoot` de `AppModule` (per `phase-01-configuracao-base/TD-02`)
3. Criar `src/storage/s3-clients.provider.ts` com dois providers (`S3_INTERNAL_CLIENT` em `S3_ENDPOINT` e `S3_PUBLIC_CLIENT` em `S3_PUBLIC_ENDPOINT`), ambos com `forcePathStyle: true` e `requestChecksumCalculation`/`responseChecksumValidation` em `'WHEN_REQUIRED'` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-12`)
4. Criar `src/storage/storage.service.ts` com `createMultipartUpload`, `presignUploadPart`, `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `putObject`, `deleteObject` (cliente interno) e `presignGetObject(key, { audience: 'public' | 'internal', expiresIn, contentDisposition? })`. Erros do SDK nas operações de complete/abort são traduzidos em resultados tipados, sem `HttpException` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-09`)
5. Criar `src/storage/storage.module.ts` exportando `StorageService` e helper `videoObjectKeys(videoId)` → `{ original: 'videos/{videoId}/original', thumbnail: 'videos/{videoId}/thumbnail.jpg' }` (per `phase-03-videos/TD-04`)
6. Criar `test/setup-env.ts`, carregado depois de `dotenv/config` no `setupFiles` das duas configs do Jest (`package.json` → `jest` e `test/jest-e2e.json`). O arquivo fixa `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque os testes rodam dentro do container `nestjs-api`, onde `localhost:9000` é o próprio container e a assinatura SigV4 amarra o host. Também fixa `QUEUE_PREFIX=bull-test`, para que o `video-worker` em execução (prefixo padrão) não consuma os jobs criados pelos testes (per `phase-03-videos/TD-05`, `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas variáveis required/defaults | `src/config/env.validation.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: MinIO real — multipart completo (parte de 5 MiB + parte final), `listParts`, abort, head, put/delete, URL pública × interna | `src/storage/storage.service.integration-spec.ts` |
| `videoObjectKeys` | Unit: formato das chaves | `src/storage/video-object-keys.spec.ts` |

**Dependencies:** SI-03.1 — MinIO e bucket precisam existir para o teste de integração

**Acceptance criteria:**

- A aplicação não inicia sem `S3_ACCESS_KEY` ou `S3_SECRET_KEY`, e o erro de validação nomeia a variável ausente
- Sem as variáveis opcionais, os namespaces resolvem os defaults da tabela (`VIDEO_MAX_SIZE_BYTES = 10737418240`, `VIDEO_UPLOAD_PART_SIZE_BYTES = 67108864`)
- Um multipart iniciado, com 2 partes enviadas por URLs assinadas e depois concluído, resulta em objeto cujo `HeadObject` informa `ContentLength` igual à soma das partes
- `listParts` após enviar a parte 1 retorna exatamente `[{ part_number: 1, etag, size }]`
- Após `abortMultipartUpload`, `listParts` para o mesmo `UploadId` falha com `NoSuchUpload`
- URLs geradas com `audience: 'public'` têm host de `S3_PUBLIC_ENDPOINT`; com `audience: 'internal'`, host de `S3_ENDPOINT`
- Uma URL de download assinada com `contentDisposition` responde com header `Content-Disposition: attachment; filename="..."`
- Nas execuções do Jest, `S3_PUBLIC_ENDPOINT` vale `http://minio:9000` e `QUEUE_PREFIX` vale `bull-test`, mesmo com o `.env` de desenvolvimento apontando para `localhost:9000`

---

### SI-03.3 — Entidade Video, migration e gerador de slug

**Description:** Persiste o vídeo com o modelo de status de processamento e a URL única, base compartilhada por API e worker.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com todos os campos de § Data Model → Video: enum `video_status` (`draft`, `processing`, `ready`, `failed`), default `draft`; `size_bytes` `bigint` com transformer `bigint ↔ number`; `ManyToOne` para `Channel` com `JoinColumn({ name: 'channel_id' })` e `onDelete: 'CASCADE'` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-06`)
2. Adicionar `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` em `src/channels/entities/channel.entity.ts`
3. Gerar `src/database/migrations/{timestamp}-CreateVideos.ts`, com tipo enum, tabela, FK, unique em `slug`, índice em `channel_id` e índices `(status, processing_started_at)` e `(status, created_at)` (consultas da reconciliação, SI-03.10), e `down` simétrico que remove o tipo enum
4. Criar `src/videos/slug.util.ts` com `generateVideoSlug()`: 8 bytes de `crypto.randomBytes` → base64url, truncado em 11 caracteres `[A-Za-z0-9_-]` (per `phase-03-videos/TD-08`)
5. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `slug`, default `draft`, enum rejeita valor inválido, cascade ao apagar o canal, `size_bytes` volta como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| `generateVideoSlug` | Unit: tamanho 11, alfabeto base64url, 10.000 chamadas sem colisão | `src/videos/slug.util.spec.ts` |
| Migrations | Integration: up/down idempotente com a nova migration | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e o tipo `video_status`; `migration:revert` remove os dois
- Inserir dois vídeos com o mesmo `slug` falha com violação de unicidade
- Um vídeo inserido sem `status` é persistido como `draft`
- Inserir um vídeo com `status = 'published'` falha no banco
- Apagar o canal apaga os vídeos dele
- Um vídeo com `size_bytes = 10737418240` é lido de volta como o número `10737418240`

---

### SI-03.4 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md`
**Authorization:** Authenticated (cria no próprio canal) — per § Authorization Matrix

**Description:** Ao iniciar o upload, o vídeo é pré-cadastrado como `draft` com URL única, e o multipart é aberto no storage; o cliente recebe o plano de partes.

**Technical actions:**

1. Criar `src/videos/videos.exceptions.ts` com as exceções de § Error Catalog, todas `extends DomainException`: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `UnsupportedVideoTypeException` (`UNSUPPORTED_VIDEO_TYPE`, 415), `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 422), `InvalidVideoStateException` (`INVALID_VIDEO_STATE`, 409), `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 422), `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 422) e `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) (per `phase-02-auth/TD-07`)
2. Criar `src/videos/dto/initiate-upload.dto.ts` (`filename`, `content_type`, `size_bytes`) e `src/videos/dto/initiate-upload-response.dto.ts`, conforme § API Contracts → POST /videos. O padrão `video/*` e o teto de tamanho são regras de domínio, não decoradores (§ Validation Rules) (per `phase-02-auth/TD-06`)
3. Expor `ChannelsService.findByUserId(userId)` e exportar `ChannelsService` em `ChannelsModule`, para que a resolução do canal do dono fique no módulo dono da entidade
4. Criar `src/videos/video-uploads.service.ts` com `initiate(userId, dto)`. O método valida tipo e tamanho; persiste o `draft`, com `title` derivado de `filename`, gerando o `slug` com até 3 tentativas em violação `23505` de `slug`; chama `createMultipartUpload` em `videoObjectKeys(id).original` e grava `upload_id`; se o storage falhar, remove o rascunho e relança; devolve `part_size` e `part_count = ceil(size_bytes / part_size)` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-08`, `phase-03-videos/TD-02`)
5. Criar `src/videos/videos.controller.ts` com `POST /videos` retornando `201`, `@CurrentUser()`, decoradores `@ApiOperation`/`@ApiResponse` (201, 400, 401, 415, 422)/`@ApiBody`, e importar `StorageModule` e `ChannelsModule` em `VideosModule` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.initiate` | Unit: tipo não `video/*`, tamanho acima do teto, retry de slug em `23505`, rollback do rascunho quando o storage falha, cálculo de `part_count` (mock repo + storage) | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.initiate` | Integration: DB + MinIO reais — rascunho persistido com `upload_id`, multipart aberto na chave `videos/{id}/original` | `src/videos/video-uploads.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — StorageService; SI-03.3 — entidade `Video` e `generateVideoSlug`

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", content_type: "video/mp4", size_bytes: 157286400 }` retorna `201` com `status: "draft"`, `slug` de 11 caracteres, `title: "aula"` e `upload: { part_size: 67108864, part_count: 3 }`
- Após o `201`, existe um vídeo `draft` no canal do usuário, com `upload_id` preenchido e multipart aberto no storage
- `POST /videos` com `content_type: "image/png"` retorna `415` com `error: "UNSUPPORTED_VIDEO_TYPE"`
- `POST /videos` com `size_bytes: 10737418241` retorna `422` com `error: "VIDEO_TOO_LARGE"`, sem criar registro
- `POST /videos` sem `filename` retorna `400`
- `POST /videos` sem token retorna `401`
- Dois uploads iniciados em sequência recebem `slug`s distintos

---

### SI-03.5 — Endpoints de partes do upload: URLs assinadas, retomada e cancelamento

**Route:** POST /videos/:id/upload/part-urls, GET /videos/:id/upload/parts, DELETE /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner only; não dono recebe 404 — per § Authorization Matrix

**Description:** Permite ao cliente enviar as partes direto ao storage, retomar um upload interrompido sem reenviar partes e cancelar o upload, sem que os bytes passem pela API.

**Technical actions:**

1. Adicionar a `VideoUploadsService` o helper privado `findOwnDraft(userId, videoId)`, que busca por `id` e pelo `channel_id` do usuário (inexistente ou alheio → `VideoNotFoundException`) e exige `status = draft` (senão `InvalidVideoStateException`) (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
2. Implementar `presignParts(userId, videoId, partNumbers)`, que rejeita números fora de `1..part_count` com `InvalidPartNumberException` e assina cada `UploadPart` com o cliente público e `expiresIn = VIDEO_UPLOAD_URL_TTL_SECONDS` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`)
3. Implementar `listUploadedParts(userId, videoId)` via `listParts` e `cancel(userId, videoId)`, que faz `abortMultipartUpload` (ignorando `NoSuchUpload`) e remove o rascunho (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`)
4. Criar `src/videos/dto/presign-parts.dto.ts` (`part_numbers`: 1–100 inteiros `≥ 1`, únicos) e os DTOs de resposta `{ parts, expires_in }` e `{ parts, part_size, part_count }` (per `phase-02-auth/TD-06`)
5. Adicionar ao `VideosController` `POST /videos/:id/upload/part-urls` (200), `GET /videos/:id/upload/parts` (200) e `DELETE /videos/:id/upload` (204), com `ParseUUIDPipe` em `:id` e decoradores OpenAPI para 200/204, 400, 401, 404, 409 e 422 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService.presignParts` / `listUploadedParts` / `cancel` | Unit: não dono → `VIDEO_NOT_FOUND`, fora de `draft` → `INVALID_VIDEO_STATE`, número fora do intervalo → `INVALID_PART_NUMBER`, `NoSuchUpload` ignorado no cancel (mock repo + storage) | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService` | Integration: DB + MinIO — parte enviada por URL assinada aparece em `listUploadedParts`; `cancel` aborta o multipart e apaga o registro | `src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — rascunho com `upload_id`, `VideosController` e exceções

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` com `{ part_numbers: [1, 2] }` retorna `200` com 2 URLs em `S3_PUBLIC_ENDPOINT` e `expires_in: 3600`
- Um `PUT` de bytes na URL da parte 1 retorna `200` com header `ETag`, e `GET /videos/:id/upload/parts` passa a listar `{ part_number: 1, etag, size }`
- `POST /videos/:id/upload/part-urls` com `part_numbers: [999]` num upload de 3 partes retorna `422` com `error: "INVALID_PART_NUMBER"`
- `POST /videos/:id/upload/part-urls` com `part_numbers: []` retorna `400`
- `DELETE /videos/:id/upload` retorna `204`; em seguida, `GET /videos/:id/upload/parts` retorna `404 VIDEO_NOT_FOUND` e o multipart não existe mais no storage
- As três rotas, chamadas por outro usuário autenticado sobre um vídeo existente, retornam `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/not-a-uuid/upload/parts` retorna `400`

---

### SI-03.6 — Endpoint POST /videos/:id/upload/complete e publicação do job de processamento

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner only; não dono recebe 404 — per § Authorization Matrix

**Description:** Conclui o upload, confere o tamanho real, faz a transição do vídeo para `processing` e enfileira o processamento automático, fechando o handshake conduzido pelo cliente.

**Technical actions:**

1. Instalar `@nestjs/bullmq` e `bullmq` (versões de `library-refs.md`) e criar `src/queue/queue.module.ts` com `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port }, prefix: cfg.prefix }) })` e a constante `VIDEO_PROCESSING_QUEUE = 'video-processing'` em `src/queue/queue.constants.ts` (per `phase-03-videos/TD-01`)
2. Criar `src/videos/video-processing.producer.ts` (`VideoProcessingProducer.enqueue(videoId)`), que chama `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true, removeOnFail: true })`, num `src/videos/video-queue.module.ts` (`VideoQueueModule`) que registra `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` e exporta a fila e o producer. O módulo é importado por `VideosModule` agora e, depois, pelo módulo do worker (per `phase-03-videos/TD-01`, `phase-03-videos/TD-11`; § Events/Messages → process-video)
3. Implementar `VideoUploadsService.complete(userId, videoId, parts)`. Ordena as partes e chama `completeMultipartUpload`; rejeição do storage vira `UploadIncompleteException`. Em seguida faz `headObject`: acima de `VIDEO_MAX_SIZE_BYTES`, remove o objeto e lança `VideoTooLargeException`. Persiste `size_bytes` real, `upload_id = null`, `status = processing` e `processing_started_at = now()`, depois chama `enqueue`. Uma falha no enqueue é só logada, porque a reconciliação do SI-03.10 recupera (per `phase-03-videos/TD-03`, `phase-03-videos/TD-02`, `phase-03-videos/TD-11`)
4. Criar `src/videos/dto/complete-upload.dto.ts` (`parts`: 1–10.000 itens `{ part_number, etag }`, com `@ValidateNested` e `@Type`) e o DTO de resposta `{ id, slug, status }` (per `phase-02-auth/TD-06`)
5. Adicionar ao `VideosController` `POST /videos/:id/upload/complete` com `@HttpCode(202)` e decoradores OpenAPI para 202, 400, 401, 404, 409 e 422 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test (falta de `forRootAsync` gera `MissingBullSharedConfigurationError`) | `src/queue/queue.module.spec.ts` |
| `VideoUploadsService.complete` | Unit: storage rejeita → `UPLOAD_INCOMPLETE`, tamanho real acima do teto → objeto removido + `VIDEO_TOO_LARGE`, falha no enqueue não desfaz a transição (mock repo + storage + producer) | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService.complete` | Integration: DB + MinIO + Valkey reais — vídeo vira `processing` e a fila tem um job `process-video` com `jobId = videoId` | `src/videos/video-uploads.service.integration-spec.ts` |
| `VideoProcessingProducer` | Integration: Valkey real — dois `enqueue` do mesmo id resultam em um único job | `src/videos/video-processing.producer.integration-spec.ts` |
| `VideoQueueModule` | Unit: compilation test | `src/videos/video-queue.module.spec.ts` |

**Dependencies:** SI-03.5 — partes enviadas e `findOwnDraft`; SI-03.1 — Valkey

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` com todas as partes enviadas e seus ETags retorna `202` com `status: "processing"`
- Após o `202`, o vídeo tem `status = processing`, `upload_id = null`, `processing_started_at` preenchido e `size_bytes` igual ao tamanho real do objeto
- Após o `202`, a fila `video-processing` contém um job `process-video` com `data: { videoId }`
- Repetir `POST /videos/:id/upload/complete` no mesmo vídeo retorna `409` com `error: "INVALID_VIDEO_STATE"`, sem um segundo job na fila
- `POST /videos/:id/upload/complete` com um ETag que não corresponde à parte retorna `422` com `error: "UPLOAD_INCOMPLETE"`, e o vídeo continua `draft`
- `POST /videos/:id/upload/complete` com `parts: []` retorna `400`
- A rota, chamada por outro usuário autenticado, retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.7 — Infra: entrypoint e container do video worker

**Description:** Cria o processo separado do worker (mesmo codebase, entrypoint próprio, sem servidor HTTP) e o serviço Compose que o executa, como pede o diagrama C4.

**Technical actions:**

1. Criar `src/worker.module.ts` (`WorkerModule`) importando `ConfigModule.forRoot` (mesmos namespaces e `envValidationSchema` do `AppModule`), `TypeOrmModule.forRootAsync` (mesmo `databaseConfig`, `autoLoadEntities`), `QueueModule` e `StorageModule`, sem `AuthModule` nem controllers (per `phase-03-videos/TD-06`, `phase-01-configuracao-base/TD-03`)
2. Criar `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks()` e log de inicialização, sem `listen` (per `phase-03-videos/TD-06`)
3. Adicionar os scripts `start:worker:dev` (`nest start --entryFile worker --watch`) e `start:worker:prod` (`node dist/worker`) ao `package.json` (per `phase-03-videos/TD-06`)
4. Adicionar ao `compose.yaml` o serviço `video-worker` (mesmo build `Dockerfile.dev`, mesmo volume, `command: npm run start:worker:dev`, `depends_on` `db`, `valkey` e `minio-init`), usando os mesmos `.env` e nomes de serviço como host (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test (DI completo, sem dependência de HTTP) | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.6 — `QueueModule`; SI-03.2 — `StorageModule`

**Acceptance criteria:**

- `docker compose up -d video-worker` deixa o container em execução, e `docker compose logs video-worker` mostra a inicialização sem erro de DI
- O container `video-worker` não expõe porta HTTP
- Parar o container (`docker compose stop video-worker`) encerra o processo de forma limpa, sem erro de conexão pendente no log
- `npm run build` gera `dist/worker.js` além de `dist/main.js`

---

### SI-03.8 — Serviço de mídia: extração de metadados e thumbnail com ffprobe/ffmpeg

**Description:** Isola as chamadas nativas a `ffprobe` e `ffmpeg` (leitura por URL assinada, sem copiar o vídeo para o disco do worker) num serviço testável, que o processor consome.

**Technical actions:**

1. Criar `src/media/media.service.ts` com `probe(url)`, que roda `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url])` e devolve `{ duration_ms, width, height, video_codec, audio_codec, format_name }` a partir do primeiro stream de vídeo, do primeiro de áudio e de `format` (per `phase-03-videos/TD-07`)
2. Lançar `InvalidMediaError` (erro de domínio do worker, não HTTP) quando o ffprobe sai com código ≠ 0, a saída não é JSON válido ou não há stream de vídeo (per `phase-03-videos/TD-07`, `phase-03-videos/TD-11`)
3. Implementar `thumbnailTimestamp(durationMs)` com 10% da duração, limitado a `[0, duration − 0.1s]`, e `extractThumbnail(url, atSeconds): Promise<Buffer>` via `execFile('ffmpeg', ['-ss', t, '-i', url, '-frames:v', '1', '-vf', 'scale=1280:-2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { encoding: 'buffer', maxBuffer })` (per `phase-03-videos/TD-07`)
4. Aplicar timeout em `execFile` (`timeout` configurável, default 10 min para o probe e 2 min para a thumbnail) e criar `src/media/media.module.ts` exportando `MediaService` (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaService.thumbnailTimestamp` | Unit: 10% da duração, clamp para vídeos curtos (< 1s) e duração 0 | `src/media/media.service.spec.ts` |
| `MediaService.probe` / `extractThumbnail` | Integration: ffprobe/ffmpeg reais sobre um vídeo gerado no setup (`ffmpeg -f lavfi -i testsrc=duration=3:size=1920x1080`) servido por URL assinada do MinIO; arquivo de texto renomeado `.mp4` → `InvalidMediaError` | `src/media/media.service.integration-spec.ts` |
| `MediaModule` | Unit: compilation test | `src/media/media.module.spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg na imagem; SI-03.2 — URL assinada interna para os testes

**Acceptance criteria:**

- O probe de um vídeo de teste de 3s em 1920x1080 retorna `duration_ms` entre 2900 e 3100, `width: 1920`, `height: 1080`, `video_codec` não vazio e `audio_codec: null`
- A thumbnail extraída é um JPEG válido (começa com `FF D8`) com 1280px de largura
- O probe de um arquivo que não é vídeo falha com `InvalidMediaError`
- O processamento lê o vídeo pela URL e não grava o arquivo original em disco local

---

### SI-03.9 — Processor do job process-video (metadados, thumbnail e status terminal)

**Description:** Consome o job publicado no complete e leva o vídeo de `processing` a `ready`, com duração, metadados e thumbnail, ou a `failed` com motivo, de forma idempotente.

**Technical actions:**

1. Criar `src/videos/video-processing.service.ts` com `processVideo(videoId)`. O método carrega o vídeo e encerra sem efeito se `status !== 'processing'`; assina a URL GET do original com `audience: 'internal'`; chama `MediaService.probe` e `extractThumbnail`; faz `putObject` em `videoObjectKeys(id).thumbnail` (`image/jpeg`); e grava numa única atualização `status = ready`, os metadados, `thumbnail_key`, `processed_at` e `failure_reason = null` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)
2. Implementar `markFailed(videoId, reason)`, que só transita para `failed` se o vídeo ainda estiver `processing` (`UPDATE ... WHERE status = 'processing'`), com `failure_reason` de § Error Catalog → Motivos terminais (per `phase-03-videos/TD-11`)
3. Criar `src/videos/video-processing.processor.ts` (`@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1, lockDuration: 300000 })`, `extends WorkerHost`), que roteia `job.name === 'process-video'` para `processVideo` e converte `InvalidMediaError` em `UnrecoverableError('INVALID_MEDIA')` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-06`)
4. Adicionar `@OnWorkerEvent('failed')`, que chama `markFailed` com `INVALID_MEDIA` quando o erro é `UnrecoverableError` e com `PROCESSING_FAILED` quando `job.attemptsMade >= job.opts.attempts`. Erros são logados com `Logger` e nunca relançados fora do contexto do job (per `phase-03-videos/TD-11`)
5. Registrar `VideoProcessingService`, `VideoProcessingProcessor`, `MediaModule`, `StorageModule`, `VideoQueueModule` e `TypeOrmModule.forFeature([Video])` num `VideoProcessingModule` (`src/videos/video-processing.module.ts`), importado só pelo `WorkerModule`, para que a API não consuma jobs (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: status ≠ `processing` → no-op; `InvalidMediaError` propagado; `markFailed` ignora vídeo fora de `processing` (mock repo + storage + media) | `src/videos/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: DB + MinIO + ffmpeg reais — vídeo de teste vira `ready` com metadados e objeto `videos/{id}/thumbnail.jpg`; arquivo inválido termina `failed` com `INVALID_MEDIA` | `src/videos/video-processing.service.integration-spec.ts` |
| `VideoProcessingProcessor` | Unit: roteamento por `job.name`, conversão em `UnrecoverableError`, handler `failed` decide entre `INVALID_MEDIA` e `PROCESSING_FAILED` pela contagem de tentativas | `src/videos/video-processing.processor.spec.ts` |
| `VideoProcessingModule` | Unit: compilation test | `src/videos/video-processing.module.spec.ts` |

**Dependencies:** SI-03.8 — `MediaService`; SI-03.7 — `WorkerModule`; SI-03.6 — fila e job publicado

**Acceptance criteria:**

- Com o `video-worker` rodando, um upload concluído de um vídeo válido chega a `status = ready` com `duration_ms`, `width`, `height`, `video_codec` e `thumbnail_key` preenchidos e `processed_at` definido
- O objeto `videos/{videoId}/thumbnail.jpg` existe no bucket com `Content-Type: image/jpeg`
- Um upload concluído de um arquivo que não é vídeo termina com `status = failed` e `failure_reason = INVALID_MEDIA` após uma única tentativa
- Uma falha transitória que persiste nas 3 tentativas termina com `status = failed` e `failure_reason = PROCESSING_FAILED`
- Reexecutar o job de um vídeo já `ready` não altera o registro nem o objeto da thumbnail
- O processo do worker continua de pé depois de um job que falhou

---

### SI-03.10 — Reconciliação de processamento e limpeza de uploads abandonados

**Description:** Fecha as lacunas do handshake assíncrono: reenfileira vídeos presos em `processing` (enqueue não transacional ou job perdido) e remove rascunhos cujo upload nunca foi concluído, limitando o storage órfão.

**Technical actions:**

1. Criar `src/videos/video-reconciliation.service.ts` com `requeueStaleProcessing()`. O método busca vídeos `processing` com `processing_started_at < now() − VIDEO_PROCESSING_STALE_MINUTES`; para cada um, consulta `queue.getJob(videoId)` e, se não houver job ativo, aguardando ou atrasado, chama `VideoProcessingProducer.enqueue(videoId)` (per `phase-03-videos/TD-11`)
2. Implementar `cleanupAbandonedUploads()`, que busca vídeos `draft` com `created_at < now() − VIDEO_ABANDONED_UPLOAD_HOURS` e, para cada um, faz `abortMultipartUpload` (ignorando `NoSuchUpload`), `deleteObject` do original e remove o registro; falha em um vídeo é logada sem interromper os demais (per `phase-03-videos/TD-11`, `phase-03-videos/TD-04`)
3. Rotear `job.name === 'reconcile-videos'` no `VideoProcessingProcessor` para os dois métodos, em sequência (per `phase-03-videos/TD-06`; § Events/Messages → reconcile-videos)
4. Registrar no bootstrap do worker (`OnApplicationBootstrap` no `VideoProcessingModule`) `queue.upsertJobScheduler('reconcile-videos', { every: 900000 }, { name: 'reconcile-videos', data: {} })`, operação idempotente entre reinícios (per `phase-03-videos/TD-01`, `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoReconciliationService` | Unit: vídeo com job vivo não é reenfileirado; erro em um rascunho não interrompe os demais (mock repo + queue + storage) | `src/videos/video-reconciliation.service.spec.ts` |
| `VideoReconciliationService` | Integration: DB + MinIO + Valkey reais — `processing` antigo sem job ganha job; `draft` antigo com multipart aberto é abortado e removido; registros recentes ficam intactos | `src/videos/video-reconciliation.service.integration-spec.ts` |

**Dependencies:** SI-03.9 — processor e `VideoProcessingModule`

**Acceptance criteria:**

- Um vídeo `processing` com `processing_started_at` de 2 horas atrás e sem job na fila ganha um job `process-video` na execução da reconciliação e, com o worker ativo, termina `ready`
- Um vídeo `processing` cujo job ainda está na fila não ganha um segundo job
- Um vídeo `draft` criado há mais de 24h tem o multipart abortado e o registro removido; um `draft` criado há 1h permanece
- Depois de reiniciar o worker, a fila tem exatamente um job scheduler `reconcile-videos`, com intervalo de 900000 ms

---

### SI-03.11 — Endpoints GET /videos/:slug, /stream e /download

**Route:** GET /videos/:slug, GET /videos/:slug/stream, GET /videos/:slug/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Owner only; não dono recebe 404; stream e download só para `ready` — per § Authorization Matrix

**Description:** Expõe o vídeo pela URL única ao dono, para acompanhar o processamento, e entrega streaming e download por URLs pré-assinadas servidas direto pelo storage, com `Range`/`206` nativo e zero bytes pela API.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` com `findOwnBySlug(userId, slug)`, que busca filtrando por `slug` e pelo `channel_id` do usuário; inexistente ou alheio → `VideoNotFoundException` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-08`)
2. Implementar `getDetails(userId, slug)`, que monta a resposta de § API Contracts → GET /videos/:slug com `thumbnail_url` assinada pelo cliente público quando `ready` (`null` nos demais), via `StorageService.presignGetObject(..., { audience: 'public', expiresIn: VIDEO_PLAYBACK_URL_TTL_SECONDS })` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-05`)
3. Implementar `getStreamUrl(userId, slug)` e `getDownloadUrl(userId, slug)`: vídeo fora de `ready` → `VideoNotReadyException`. O download assina `contentDisposition: attachment; filename="{original_filename}"`, sem caracteres de controle e `"` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-12`)
4. Criar a validação de `:slug` (`^[A-Za-z0-9_-]{11}$`, via `ParseSlugPipe` em `src/videos/pipes/parse-slug.pipe.ts` ou DTO de params) e os DTOs de resposta `VideoDetailsResponseDto` e `PlaybackUrlResponseDto` (`{ url, expires_in }`) (per `phase-02-auth/TD-06`)
5. Adicionar ao `VideosController` `GET /videos/:slug`, `GET /videos/:slug/stream` e `GET /videos/:slug/download` (200), declarados depois das rotas `:id/upload/*` para não haver conflito de rota, com decoradores OpenAPI para 200, 400, 401, 404 e 409 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: `thumbnail_url` só quando `ready`, `VIDEO_NOT_READY` fora de `ready`, sanitização do filename no `Content-Disposition` (mock repo + storage) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: DB + MinIO — busca filtra por canal (vídeo alheio → `VIDEO_NOT_FOUND`); URL de stream com `Range: bytes=0-99` responde `206` com 100 bytes | `src/videos/videos.service.integration-spec.ts` |
| `ParseSlugPipe` | Unit: aceita 11 chars base64url, rejeita tamanho e alfabeto inválidos | `src/videos/pipes/parse-slug.pipe.spec.ts` |

**Dependencies:** SI-03.4 — `VideosController` e exceções; SI-03.9 — vídeos `ready` com thumbnail

**Acceptance criteria:**

- `GET /videos/:slug` de um vídeo `ready` do próprio usuário retorna `200` com `duration_ms`, `width`, `height` e `thumbnail_url` acessível (GET na URL retorna `200` `image/jpeg`)
- `GET /videos/:slug` de um vídeo `processing` retorna `200` com `status: "processing"` e `thumbnail_url: null`
- `GET /videos/:slug/stream` de um vídeo `ready` retorna `200` com `url` e `expires_in: 14400`; um GET nessa URL com `Range: bytes=0-1023` responde `206` com `Content-Range` e 1024 bytes
- `GET /videos/:slug/download` de um vídeo `ready` retorna uma `url` cuja resposta traz `Content-Disposition: attachment; filename="{original_filename}"`
- `GET /videos/:slug/stream` e `/download` de um vídeo `processing` retornam `409` com `error: "VIDEO_NOT_READY"`
- As três rotas, chamadas por outro usuário autenticado, retornam `404` com `error: "VIDEO_NOT_FOUND"`, igual a um slug inexistente
- `GET /videos/abc` retorna `400`; sem token, as três rotas retornam `401`

---

### SI-03.12 — Contrato OpenAPI exportado e requisições de exemplo

**Description:** Mantém o `openapi.json` versionado em sincronia com os 8 endpoints novos e documenta o fluxo completo de upload → processamento → streaming para uso manual.

**Technical actions:**

1. Rodar `npm run openapi:export` e versionar o `nestjs-project/openapi.json` atualizado com as rotas `/videos/**`, os schemas de request/response e o envelope de erro de cada status (per `openapi-docs-nestjs/TD-02`, `openapi-docs-nestjs/TD-01`)
2. Acrescentar a `nestjs-project/api.http` a sequência `POST /videos` → `part-urls` → `PUT` na URL da parte → `complete` → `GET /videos/:slug` → `stream` / `download`, com variáveis encadeadas

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` exportado | Integration: o export reflete o documento gerado em runtime (suite existente, passa a cobrir `/videos`) | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.11 — último endpoint da fase

**Acceptance criteria:**

- `openapi.json` contém os 8 paths de § API Contracts, cada um com as respostas de status listadas ali
- Os schemas de erro de `/videos/**` usam o envelope `{ statusCode, error, message }`
- Rodar `npm run openapi:export` de novo não produz diff no `openapi.json`

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. Entidade única compartilhada pela API e pelo worker *(per phase-03-videos/TD-06)*.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → `channels.id`, not null, `ON DELETE CASCADE` |
| slug | varchar(11) | unique, not null — 11 chars base64url aleatórios (`[A-Za-z0-9_-]{11}`), gerado na criação do rascunho com retry em violação de unicidade *(per phase-03-videos/TD-08)* |
| title | varchar(100) | not null — derivado do nome do arquivo (sem extensão, truncado em 100); editável só na Fase 04 |
| status | enum `video_status` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` — ciclo só de processamento; publicação é separada (Fase 04) *(per phase-03-videos/TD-10)* |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null — `video/*` declarado pelo cliente *(per phase-03-videos/TD-02)* |
| size_bytes | bigint | not null — tamanho declarado na iniciação; sobrescrito pelo `ContentLength` do `HeadObject` na conclusão *(per phase-03-videos/TD-02)*. Transformer `bigint ↔ number` (máx. 10 GiB < `Number.MAX_SAFE_INTEGER`) |
| upload_id | varchar(1024) | nullable — `UploadId` do multipart S3 enquanto `draft`; `null` após complete/abort *(per phase-03-videos/TD-02)* |
| duration_ms | integer | nullable — preenchido pelo worker (ffprobe) *(per phase-03-videos/TD-07)* |
| width | integer | nullable — stream de vídeo principal (ffprobe) |
| height | integer | nullable — stream de vídeo principal (ffprobe) |
| video_codec | varchar(50) | nullable — `codec_name` do stream de vídeo |
| audio_codec | varchar(50) | nullable — `codec_name` do primeiro stream de áudio; `null` se não houver |
| format_name | varchar(100) | nullable — `format.format_name` do ffprobe |
| thumbnail_key | varchar(255) | nullable — chave do objeto da thumbnail; preenchida quando `ready` *(per phase-03-videos/TD-07)* |
| failure_reason | varchar(255) | nullable — motivo terminal quando `failed`; limpo ao reprocessar *(per phase-03-videos/TD-11)* |
| processing_started_at | timestamptz | nullable — instante da transição `draft → processing` (base da reconciliação, TD-11) |
| processed_at | timestamptz | nullable — instante da transição para `ready` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), on update |

**Relations:** `Channel` has many `Video` (one-to-many; `Video.channel` ↔ `Channel.videos`). O dono do vídeo é o usuário dono do canal (`channels.user_id`), cada usuário com exatamente um canal.
**Indexes:** unique on `slug`; index on `channel_id`; index on `(status, processing_started_at)` (re-enfileiramento de `processing` parados) e index on `(status, created_at)` (limpeza de `draft` abandonados), ambos da reconciliação (TD-11).

**Transições de status permitidas** *(per phase-03-videos/TD-03, phase-03-videos/TD-10, phase-03-videos/TD-11)*:

| From | To | Quem dispara |
|------|----|--------------|
| — | `draft` | API, na iniciação do upload (`POST /videos`) |
| `draft` | `processing` | API, no `POST /videos/:id/upload/complete` bem-sucedido (antes de enfileirar) |
| `processing` | `ready` | Worker, após ffprobe + thumbnail persistidos |
| `processing` | `failed` | Worker, em erro não recuperável ou na última tentativa |
| `draft` | _(removido)_ | API (`DELETE /videos/:id/upload`) ou limpeza de uploads abandonados |

Qualquer outra transição é rejeitada (`409 INVALID_VIDEO_STATE` na API; no worker, job em vídeo fora de `processing` é no-op idempotente).

#### Object storage layout

Bucket privado único, chaves imutáveis agrupadas por id do vídeo, independentes do input do usuário *(per phase-03-videos/TD-04)*:

| Objeto | Chave | Gravado por |
|--------|-------|-------------|
| Arquivo original | `videos/{videoId}/original` | Cliente, via multipart com URLs pré-assinadas *(per phase-03-videos/TD-02)* |
| Thumbnail | `videos/{videoId}/thumbnail.jpg` | Worker, `PutObject` com `ContentType: image/jpeg` *(per phase-03-videos/TD-07)* |

Bootstrap do bucket: criação idempotente, CORS liberando `PUT` das origens do frontend e **expondo o header `ETag`** (necessário para o cliente concluir o multipart), e regra de lifecycle que aborta multiparts incompletos após 1 dia *(per phase-03-videos/TD-04, phase-03-videos/TD-11)*.

#### Configuração (namespaces `registerAs`)

Seguindo as convenções herdadas (um arquivo por domínio em `src/config/`, validação Joi em `env.validation.ts`, injeção via `ConfigType`):

| Namespace | Arquivo | Variáveis (default) |
|-----------|---------|---------------------|
| `storage` | `src/config/storage.config.ts` | `S3_ENDPOINT` (`http://minio:9000`), `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`), `S3_REGION` (`us-east-1`), `S3_ACCESS_KEY` (required), `S3_SECRET_KEY` (required), `S3_BUCKET` (`streamtube-videos`) *(per phase-03-videos/TD-05, phase-03-videos/TD-12)* |
| `queue` | `src/config/queue.config.ts` | `QUEUE_HOST` (`valkey`), `QUEUE_PORT` (`6379`), `QUEUE_PREFIX` (`bull`; os testes usam `bull-test`, ver SI-03.2) *(per phase-03-videos/TD-01)* |
| `videos` | `src/config/videos.config.ts` | `VIDEO_MAX_SIZE_BYTES` (`10737418240` = 10 GiB), `VIDEO_UPLOAD_PART_SIZE_BYTES` (`67108864` = 64 MiB), `VIDEO_UPLOAD_URL_TTL_SECONDS` (`3600`), `VIDEO_PLAYBACK_URL_TTL_SECONDS` (`14400`), `VIDEO_ABANDONED_UPLOAD_HOURS` (`24`), `VIDEO_PROCESSING_STALE_MINUTES` (`60`) *(per phase-03-videos/TD-02, phase-03-videos/TD-09, phase-03-videos/TD-11)* |

Dois `S3Client` (`requestChecksumCalculation` e `responseChecksumValidation` em `WHEN_REQUIRED`, `forcePathStyle: true`): o **interno** (`S3_ENDPOINT`) faz todas as operações de servidor; o **público** (`S3_PUBLIC_ENDPOINT`) só assina URLs entregues ao cliente *(per phase-03-videos/TD-05, phase-03-videos/TD-12)*. O worker assina a URL de leitura do ffprobe/ffmpeg com o cliente **interno** *(per phase-03-videos/TD-07)*.

### API Contracts

Todos os endpoints exigem `Authorization: Bearer <access_token>` (guard JWT global da Fase 02) e respondem erros no envelope `{ statusCode, error, message }` *(per phase-02-auth/TD-07)*. O handshake de upload é conduzido pelo cliente através da API; os bytes nunca passam pela API *(per phase-03-videos/TD-02, phase-03-videos/TD-03)*. Endpoints de gestão do upload usam `:id` (uuid); endpoints de leitura usam `:slug`, a URL única do vídeo *(per phase-03-videos/TD-08)*. Todos os endpoints levam decoradores OpenAPI explícitos (`@ApiOperation`, `@ApiResponse` por status, `@ApiBody`, `@ApiParam`) *(per openapi-docs-nestjs/TD-01)*.

#### POST /videos (SI-03.4)

Pré-cadastra o vídeo como `draft` e inicia o multipart (`CreateMultipartUpload` na chave `videos/{videoId}/original`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- filename: string, required — 1–255 caracteres
- content_type: string, required — deve casar `^video\/[\w.+-]+$`
- size_bytes: integer, required — `≥ 1` e `≤ VIDEO_MAX_SIZE_BYTES` (10 GiB)

**Response 201:**
- id: string (uuid)
- slug: string (11 chars base64url)
- title: string
- status: `"draft"`
- size_bytes: number
- upload: object
  - part_size: number (bytes; `VIDEO_UPLOAD_PART_SIZE_BYTES`)
  - part_count: number (`ceil(size_bytes / part_size)`, ≤ 10.000)

**Error responses:**
- 400 validation error: body inválido (campos ausentes, tipos errados)
- 415 UNSUPPORTED_VIDEO_TYPE: `content_type` não é `video/*`
- 422 VIDEO_TOO_LARGE: `size_bytes` acima de `VIDEO_MAX_SIZE_BYTES`
- 401 (guard): token ausente ou inválido

---

#### POST /videos/:id/upload/part-urls (SI-03.5)

Assina (cliente público) URLs `UploadPart` para as partes pedidas. Usado no início e na retomada (re-assinatura) *(per phase-03-videos/TD-02, phase-03-videos/TD-05)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- part_numbers: integer[], required — 1–100 itens, únicos, cada um entre `1` e `part_count`

**Response 200:**
- parts: array of `{ part_number: number, url: string }`
- expires_in: number (segundos; `VIDEO_UPLOAD_URL_TTL_SECONDS`)

**Error responses:**
- 400 validation error: `:id` não é uuid; `part_numbers` vazio, duplicado ou com mais de 100 itens
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft`
- 422 INVALID_PART_NUMBER: algum `part_number` fora de `1..part_count`

---

#### GET /videos/:id/upload/parts (SI-03.5)

Lista as partes já recebidas pelo storage (`ListParts`), para o cliente retomar o upload sem reenviar partes.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- parts: array of `{ part_number: number, etag: string, size: number }`
- part_size: number
- part_count: number

**Error responses:**
- 400 validation error: `:id` não é uuid
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft`

---

#### POST /videos/:id/upload/complete (SI-03.6)

Conclui o multipart (`CompleteMultipartUpload`), confere o tamanho real (`HeadObject`), faz a transição `draft → processing` e enfileira o job de processamento *(per phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-01)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- parts: array, required — 1–10.000 itens de `{ part_number: integer ≥ 1, etag: string não vazia }`, `part_number` únicos

**Response 202:**
- id: string (uuid)
- slug: string
- status: `"processing"`

**Error responses:**
- 400 validation error: body inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft` (inclui conclusão repetida)
- 422 UPLOAD_INCOMPLETE: o storage rejeitou a lista de partes (parte ausente, ETag divergente, parte menor que o mínimo)
- 422 VIDEO_TOO_LARGE: `ContentLength` real acima de `VIDEO_MAX_SIZE_BYTES`; o objeto é removido e o vídeo permanece `draft` para limpeza

---

#### DELETE /videos/:id/upload (SI-03.5)

Cancela o upload: `AbortMultipartUpload` e remoção do rascunho.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 400 validation error: `:id` não é uuid
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft`

---

#### GET /videos/:slug (SI-03.11)

Detalhes do vídeo para o dono (inclusive para acompanhar o processamento).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- original_filename: string
- content_type: string
- size_bytes: number
- duration_ms: number | null
- width: number | null
- height: number | null
- video_codec: string | null
- audio_codec: string | null
- format_name: string | null
- thumbnail_url: string | null — URL GET pré-assinada (cliente público) quando `ready`; `null` nos demais status
- failure_reason: string | null
- created_at: string (ISO-8601)
- processed_at: string (ISO-8601) | null

**Error responses:**
- 400 validation error: `:slug` não casa `^[A-Za-z0-9_-]{11}$`
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário

---

#### GET /videos/:slug/stream (SI-03.11)

URL GET pré-assinada (cliente público) do arquivo original, servida pelo storage com `Range`/`206` nativo; zero bytes pela API *(per phase-03-videos/TD-09)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string
- expires_in: number (segundos; `VIDEO_PLAYBACK_URL_TTL_SECONDS`)

**Error responses:**
- 400 validation error: `:slug` inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 VIDEO_NOT_READY: vídeo não está em `ready`

---

#### GET /videos/:slug/download (SI-03.11)

Igual ao stream, com `ResponseContentDisposition: attachment; filename="{original_filename}"` assinado na URL *(per phase-03-videos/TD-09, phase-03-videos/TD-12)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string
- expires_in: number (segundos)

**Error responses:**
- 400 validation error: `:slug` inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 VIDEO_NOT_READY: vídeo não está em `ready`

---

#### Validation Rules — videos

- `filename`: string, obrigatório, 1–255 caracteres; caracteres de controle e `"` são removidos antes de usar no `Content-Disposition`
- `content_type`: string, obrigatório, `^video\/[\w.+-]+$` (violação → `415 UNSUPPORTED_VIDEO_TYPE`, não 400)
- `size_bytes`: inteiro, obrigatório, `≥ 1`; acima do limite → `422 VIDEO_TOO_LARGE` (regra de domínio, não de DTO, para devolver o código específico)
- `part_numbers`: array de inteiros, 1–100 itens, únicos, `≥ 1`
- `parts`: array, 1–10.000 itens, `part_number` inteiro `≥ 1` e único, `etag` string não vazia
- `:id`: uuid (`ParseUUIDPipe`)
- `:slug`: `^[A-Za-z0-9_-]{11}$`

### Authorization Matrix

Na Fase 03 não existe publicação: todo vídeo é efetivamente não publicado, então só o dono acessa, e qualquer outro chamador recebe `404 VIDEO_NOT_FOUND` (nunca 403, para não revelar existência). Stream e download só para vídeos `ready`. A Fase 04 reabre a regra para acesso público, não listado e anônimo *(per phase-03-videos/TD-09)*. "Owner" = usuário autenticado cujo canal (`channels.user_id = jwt.sub`) é o `channel_id` do vídeo.

| Endpoint | Anonymous | Authenticated (não dono) | Owner |
|----------|-----------|--------------------------|-------|
| POST /videos | ✗ (401) | ✓ (cria no próprio canal) | ✓ |
| POST /videos/:id/upload/part-urls | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:id/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| DELETE /videos/:id/upload | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:slug | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:slug/stream | ✗ (401) | ✗ (404) | ✓ (`ready` only) |
| GET /videos/:slug/download | ✗ (401) | ✗ (404) | ✓ (`ready` only) |

A verificação de dono é feita no service, com a query filtrando por canal do usuário (`WHERE id/slug = :x AND channel_id = :ownChannelId`). Assim, inexistente e alheio produzem o mesmo 404 sem uma segunda consulta.

### Error Catalog

Formato herdado: `{ statusCode, error, message }`, com `error` = `errorCode` da `DomainException` *(per phase-02-auth/TD-07)*. Novas exceções em `src/common/exceptions/domain.exception.ts` (ou arquivo do módulo `videos/`, seguindo o padrão `extends DomainException`).

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente ou pertencente a outro usuário (todas as rotas `:id` e `:slug`) |
| UNSUPPORTED_VIDEO_TYPE | 415 | `content_type` na iniciação não é `video/*` |
| VIDEO_TOO_LARGE | 422 | `size_bytes` declarado ou `ContentLength` real acima de `VIDEO_MAX_SIZE_BYTES` |
| INVALID_VIDEO_STATE | 409 | Operação de upload (part-urls, list parts, complete, abort) em vídeo fora de `draft` |
| INVALID_PART_NUMBER | 422 | `part_number` fora de `1..part_count` ao pedir URLs |
| UPLOAD_INCOMPLETE | 422 | `CompleteMultipartUpload` rejeitado pelo storage (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) |
| VIDEO_NOT_READY | 409 | Stream ou download de vídeo fora de `ready` |

**Motivos terminais de processamento** (`videos.failure_reason`, não são respostas HTTP) *(per phase-03-videos/TD-07, phase-03-videos/TD-11)*:

| failure_reason | Quando |
|----------------|--------|
| `INVALID_MEDIA` | ffprobe não lê o arquivo ou não há stream de vídeo, com `UnrecoverableError` e sem retry |
| `PROCESSING_FAILED` | Erro transitório (storage, ffmpeg, DB) que esgotou as tentativas |

### Events/Messages

Fila BullMQ `video-processing` no broker Valkey (`QUEUE_HOST=valkey`, nome do serviço Compose; `maxmemory-policy noeviction`), com chaves sob `QUEUE_PREFIX` (`bull` em execução normal, `bull-test` nas suítes do Jest, isolando os testes do `video-worker`) *(per phase-03-videos/TD-01)*.

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoUploadsService` (API), em `POST /videos/:id/upload/complete`, depois de persistir `status = processing` *(per phase-03-videos/TD-03)*. Opções do job: `jobId: videoId` (deduplicação), `attempts: 3`, `backoff: { type: 'exponential', delay: 10000 }`, `removeOnComplete: true`, `removeOnFail: true`, porque o estado de verdade é a tabela `videos` *(per phase-03-videos/TD-01, phase-03-videos/TD-11)*.
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing', { concurrency: 1, lockDuration: 300000 })`, `extends WorkerHost`) no entrypoint separado do worker (`src/worker.ts` → `WorkerModule`), container Compose `video-worker` com FFmpeg *(per phase-03-videos/TD-06)*.
**Trigger:** upload concluído com sucesso pelo cliente.
**Processing:**
1. Carrega o vídeo; se `status !== 'processing'`, encerra sem efeito (job idempotente).
2. Assina uma URL GET do original com o cliente S3 **interno** e roda `ffprobe -v error -print_format json -show_format -show_streams <url>` via `execFile` *(per phase-03-videos/TD-07)*.
3. Sem stream de vídeo ou ffprobe com saída inválida, lança `UnrecoverableError('INVALID_MEDIA')`.
4. Thumbnail: frame em `10%` da duração (limitado a `[0, duration − 0.1s]`), JPEG com 1280px de largura, `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 -f image2 -c:v mjpeg pipe:1`, e `PutObject` em `videos/{videoId}/thumbnail.jpg` *(per phase-03-videos/TD-07)*.
5. Uma única atualização: `status = ready`, metadados, `thumbnail_key`, `processed_at = now()`, `failure_reason = null`.
**On failure:** `@OnWorkerEvent('failed')` marca `status = failed` + `failure_reason` quando o erro é `UnrecoverableError` ou quando `job.attemptsMade >= job.opts.attempts`. Erros são logados e nunca relançados fora do contexto do job *(per phase-03-videos/TD-11)*.
**Delivery semantics:** at-least-once, com processamento idempotente (passo 1 + chaves de objeto determinísticas sobrescritas) *(per phase-03-videos/TD-01, phase-03-videos/TD-11)*.

#### reconcile-videos

**Payload:**

```json
{}
```

**Producer:** job scheduler BullMQ (`queue.upsertJobScheduler('reconcile-videos', { every: 900000 })`), registrado pelo worker no bootstrap, a cada 15 min *(per phase-03-videos/TD-11)*.
**Consumer:** `VideoProcessingProcessor` (mesmo processor, roteado por `job.name`) *(per phase-03-videos/TD-06)*.
**Trigger:** periódico.
**Processing:**
1. **Re-enfileiramento:** vídeos `processing` com `processing_started_at` mais antigo que `VIDEO_PROCESSING_STALE_MINUTES` e sem job ativo, aguardando ou atrasado com `jobId = videoId`. Reenfileira `process-video` com as mesmas opções. Cobre o enqueue não transacional entre o commit no DB e o `queue.add`.
2. **Uploads abandonados:** vídeos `draft` com `created_at` mais antigo que `VIDEO_ABANDONED_UPLOAD_HOURS`. Faz `AbortMultipartUpload` (ignorando `NoSuchUpload`), remove o objeto original, se existir, e apaga o registro. A regra de lifecycle do bucket é a segunda linha de defesa para partes órfãs *(per phase-03-videos/TD-04)*.
**Delivery semantics:** best-effort; cada execução é idempotente e a seguinte corrige o que a anterior não concluiu.

---

## Dependency Map

```
SI-03.1 (root — infra: Valkey, MinIO + bucket, FFmpeg)
├── SI-03.2 — depends on SI-03.1 (MinIO para o StorageService)
│   ├── SI-03.4 — depends on SI-03.2 + SI-03.3 (storage + entidade para o pré-cadastro)
│   │   └── SI-03.5 — depends on SI-03.4 (rascunho com upload_id)
│   │       └── SI-03.6 — depends on SI-03.5 + SI-03.1 (partes enviadas; Valkey para a fila)
│   │           └── SI-03.7 — depends on SI-03.6 + SI-03.2 (QueueModule e StorageModule no worker)
│   │               └── SI-03.9 — depends on SI-03.8 + SI-03.7 + SI-03.6 (mídia, worker, job publicado)
│   │                   ├── SI-03.10 — depends on SI-03.9 (processor e VideoProcessingModule)
│   │                   └── SI-03.11 — depends on SI-03.9 + SI-03.4 (vídeos ready; controller e exceções)
│   │                       └── SI-03.12 — depends on SI-03.11 (último endpoint da fase)
│   └── SI-03.8 — depends on SI-03.1 + SI-03.2 (FFmpeg; URL assinada interna nos testes)
SI-03.3 (root, independent — entidade Video, migration, slug)
```

**Caminho crítico:** SI-03.1 → 03.2 → 03.4 → 03.5 → 03.6 → 03.7 → 03.9 → 03.11 → 03.12. SI-03.3 e SI-03.8 podem ser feitos em paralelo ao trecho de upload.

---

## Deliverables

- [ ] SI-03.1 — Infra: broker de fila, object storage e FFmpeg no ambiente Docker
- [ ] SI-03.2 — Configuração e StorageModule (clientes S3 interno/público)
- [ ] SI-03.3 — Entidade Video, migration e gerador de slug
- [ ] SI-03.4 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- [ ] SI-03.5 — Endpoints de partes do upload: URLs assinadas, retomada e cancelamento
- [ ] SI-03.6 — Endpoint POST /videos/:id/upload/complete e publicação do job de processamento
- [ ] SI-03.7 — Infra: entrypoint e container do video worker
- [ ] SI-03.8 — Serviço de mídia: extração de metadados e thumbnail com ffprobe/ffmpeg
- [ ] SI-03.9 — Processor do job process-video (metadados, thumbnail e status terminal)
- [ ] SI-03.10 — Reconciliação de processamento e limpeza de uploads abandonados
- [ ] SI-03.11 — Endpoints GET /videos/:slug, /stream e /download
- [ ] SI-03.12 — Contrato OpenAPI exportado e requisições de exemplo

**Full test suites:**

- [ ] Infra pronta (`cd nestjs-project && docker compose up -d && docker compose ps`), com `db`, `valkey`, `minio` e `video-worker` em execução e `minio-init` encerrado com código 0
- [ ] Unit + integration tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`), gerando `dist/main.js` e `dist/worker.js`
- [ ] Upload real de um arquivo de vídeo > 5 GiB pelo fluxo de `api.http` termina em `ready` com streaming (`206`) e download funcionando, sem aumento relevante de memória no container `nestjs-api`
