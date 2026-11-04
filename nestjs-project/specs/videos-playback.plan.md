---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-playback.e2e-spec.ts
---

# GET /videos/:slug, /stream, /download — Test Plan

## Application Overview

Leitura do vídeo pela URL única (`slug`), restrita ao dono na Fase 03. Vídeo alheio ou inexistente → `404 VIDEO_NOT_FOUND`, sem revelar existência. `GET /videos/:slug` devolve os detalhes e o estado do processamento, com `thumbnail_url` pré-assinada quando `ready` e `null` nos demais status. `GET /videos/:slug/stream` e `GET /videos/:slug/download` devolvem `{ url, expires_in }` com uma URL GET pré-assinada (endpoint público), válida por `VIDEO_PLAYBACK_URL_TTL_SECONDS` (14400). O storage serve os bytes com suporte nativo a `Range`/`206`, e a URL de download inclui `Content-Disposition: attachment`. Stream e download de vídeo fora de `ready` → `409 VIDEO_NOT_READY`.

## Test Scenarios

### 1. Detalhes do vídeo

**Setup:** `beforeAll` sobe `AppModule` reproduzindo a configuração global de `main.ts`. `beforeEach` roda `cleanAllTables`, limpa o prefixo `videos/` do bucket, cria dois usuários confirmados (dono e outro) e loga os dois. Seeds sem worker, gravados direto pelo repositório `Video` e pelo `StorageService`:
- vídeo `ready` do dono: `original_filename: "aula final.mp4"`; 2 MiB de bytes em `videos/{id}/original`; um JPEG em `videos/{id}/thumbnail.jpg`; `duration_ms: 3000`, `width: 1920`, `height: 1080`, `video_codec: "h264"`, `thumbnail_key` e `processed_at` preenchidos;
- vídeo `processing` do dono, sem thumbnail.

Helper `fetchPresignedUrl(url, headers)`: faz o `GET` direto na URL assinada, sem reescrevê-la (nas suítes do Jest, `S3_PUBLIC_ENDPOINT=http://minio:9000` via `test/setup-env.ts`, SI-03.2).

#### 1.1. detalhes-de-video-ready-com-thumbnail

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. GET /videos/{slugReady} como dono
    - expect: status `200`
    - expect: body com `status: "ready"`, `duration_ms: 3000`, `width: 1920`, `height: 1080`, `video_codec: "h264"`, `processed_at` ISO-8601 e `failure_reason: null`
    - expect: `thumbnail_url` com origem igual a `S3_PUBLIC_ENDPOINT`
  2. `fetchPresignedUrl(thumbnail_url)`
    - expect: status `200` com `Content-Type: image/jpeg`

#### 1.2. detalhes-de-video-processing-sem-thumbnail

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. GET /videos/{slugProcessing} como dono
    - expect: status `200` com `status: "processing"`, `thumbnail_url: null`, `duration_ms: null`

### 2. Streaming e download

**Setup:** igual ao grupo 1.

#### 2.1. stream-retorna-url-com-range-206

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. GET /videos/{slugReady}/stream como dono
    - expect: status `200` com `url` (origem `S3_PUBLIC_ENDPOINT`) e `expires_in: 14400`
  2. `fetchPresignedUrl(url, { Range: "bytes=0-1023" })`
    - expect: status `206`
    - expect: header `Content-Range: bytes 0-1023/2097152`
    - expect: corpo com 1024 bytes, iguais aos primeiros 1024 bytes do seed

#### 2.2. download-retorna-url-com-attachment

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. GET /videos/{slugReady}/download como dono
    - expect: status `200` com `url` e `expires_in: 14400`
  2. `fetchPresignedUrl(url)`
    - expect: status `200`
    - expect: header `Content-Disposition` igual a `attachment; filename="aula final.mp4"`

#### 2.3. stream-e-download-de-video-nao-pronto-retornam-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. GET /videos/{slugProcessing}/stream como dono
    - expect: status `409` com `error: "VIDEO_NOT_READY"`
  2. GET /videos/{slugProcessing}/download como dono
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

### 3. Isolamento por dono, validação e autenticação

**Setup:** igual ao grupo 1.

#### 3.1. outro-usuario-recebe-404-igual-a-slug-inexistente

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. GET /videos/{slugReady}, /stream e /download com o token do outro usuário
    - expect: as três retornam `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/AAAAAAAAAAA (slug válido e inexistente) como dono
    - expect: `404` com corpo idêntico ao do passo 1 (mesmo `error` e `message`)

#### 3.2. slug-invalido-retorna-400-e-sem-token-401

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. GET /videos/abc como dono
    - expect: status `400`
  2. GET /videos/{slugReady}, /stream e /download sem header `Authorization`
    - expect: as três retornam `401`
