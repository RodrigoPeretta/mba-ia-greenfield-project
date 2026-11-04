---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete — Test Plan

## Application Overview

`POST /videos/:id/upload/complete` fecha o handshake de upload conduzido pelo cliente. A API conclui o multipart no storage com a lista `{ part_number, etag }`, confere o tamanho real do objeto (`HeadObject`) contra `VIDEO_MAX_SIZE_BYTES`, persiste `status = processing` (com `processing_started_at`, `size_bytes` real e `upload_id = null`) e enfileira o job `process-video` na fila BullMQ `video-processing`, com `jobId = videoId`. Responde `202` com `{ id, slug, status: "processing" }`. Lista de partes rejeitada pelo storage → `422 UPLOAD_INCOMPLETE`; vídeo fora de `draft` → `409 INVALID_VIDEO_STATE`; não dono → `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Conclusão do upload e publicação do job

**Setup:** `beforeAll` sobe `AppModule` (Valkey e MinIO reais via Compose) reproduzindo a configuração global de `main.ts`; obtém a fila com `getQueueToken('video-processing')`. `beforeEach` roda `cleanAllTables`, limpa o prefixo `videos/` do bucket, executa `queue.obliterate({ force: true })`, cria dois usuários confirmados (dono e outro) e loga os dois. O dono cria um rascunho com `POST /videos` (`size_bytes: 6291456`, 1 parte) e envia a parte 1 (6 MiB) pela URL de `part-urls`, usando o helper `putToPresignedUrl`, que envia o `PUT` direto para a URL assinada (nas suítes do Jest, `S3_PUBLIC_ENDPOINT=http://minio:9000` via `test/setup-env.ts`, SI-03.2). A fila é isolada do `video-worker` pelo `QUEUE_PREFIX=bull-test` do mesmo setup. O `ETag` da resposta é guardado. O worker **não** roda nesta suíte.

#### 1.1. conclui-upload-e-enfileira-processamento

**Covers AC:** #1, #2, #3
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos/{id}/upload/complete como dono, com body `{ "parts": [{ "part_number": 1, "etag": "<ETag>" }] }`
    - expect: status `202`
    - expect: body `{ id, slug, status: "processing" }`
  2. Consultar o vídeo no banco
    - expect: `status = processing`, `upload_id` nulo, `processing_started_at` preenchido, `size_bytes = 6291456`
  3. `queue.getJob(id)`
    - expect: job existe com `name: "process-video"`, `data: { videoId: id }`, `opts.attempts: 3`

#### 1.2. conclusao-repetida-retorna-409-sem-novo-job

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. Concluir o upload como no cenário 1.1
    - expect: status `202`
  2. Repetir POST /videos/{id}/upload/complete com o mesmo body
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`
  3. `queue.getJobCounts('waiting', 'active', 'delayed')`
    - expect: a soma é `1`

### 2. Rejeições

**Setup:** igual ao grupo 1.

#### 2.1. etag-divergente-retorna-422-e-mantem-draft

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos/{id}/upload/complete como dono, com body `{ "parts": [{ "part_number": 1, "etag": "\"00000000000000000000000000000000\"" }] }`
    - expect: status `422` com `error: "UPLOAD_INCOMPLETE"`
  2. Consultar o vídeo no banco
    - expect: `status = draft` e `upload_id` ainda preenchido
    - expect: nenhum job na fila para esse `id`

#### 2.2. lista-de-partes-vazia-retorna-400

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos/{id}/upload/complete como dono, com body `{ "parts": [] }`
    - expect: status `400` no envelope de validação do projeto
    - expect: o vídeo continua `draft`

#### 2.3. outro-usuario-recebe-404

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos/{id}/upload/complete com o token do outro usuário e o body válido do cenário 1.1
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo do dono continua `draft` e nenhum job foi enfileirado
