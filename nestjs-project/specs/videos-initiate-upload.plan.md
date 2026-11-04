---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo de até 10 GiB. A API pré-cadastra o vídeo como `draft` no canal do usuário autenticado, com URL única (`slug` de 11 caracteres base64url), abre um upload multipart no storage na chave `videos/{id}/original` e devolve o plano de partes (`part_size` de 64 MiB e `part_count`). Os bytes nunca passam pela API: o cliente os envia direto ao storage nos passos seguintes (SI-03.5/SI-03.6). Tipo de conteúdo fora de `video/*` é rejeitado com `415 UNSUPPORTED_VIDEO_TYPE`, e tamanho declarado acima do teto com `422 VIDEO_TOO_LARGE`; erros seguem o envelope `{ statusCode, error, message }`.

## Test Scenarios

### 1. Pré-cadastro do rascunho e início do multipart

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule` reproduzindo a configuração global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`). `beforeEach` roda `cleanAllTables` (inclui `videos`), remove os objetos do prefixo `videos/` do bucket e aborta multiparts abertos. Cria um usuário confirmado (com canal) e obtém o `access_token` via `POST /auth/login`.

#### 1.1. inicia-upload-retorna-rascunho-e-plano-de-partes

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <token>` e body `{ "filename": "aula.mp4", "content_type": "video/mp4", "size_bytes": 157286400 }`
    - expect: status `201`
    - expect: body com `id` (uuid), `slug` casando `^[A-Za-z0-9_-]{11}$`, `title: "aula"`, `status: "draft"`, `size_bytes: 157286400`
    - expect: `upload: { part_size: 67108864, part_count: 3 }`
  2. Consultar o vídeo `id` no banco
    - expect: registro com `status = draft`, `channel_id` igual ao canal do usuário e `upload_id` não nulo
  3. `ListParts` no storage para `videos/{id}/original` com o `upload_id` persistido
    - expect: a chamada sucede com zero partes, ou seja, o multipart está aberto

#### 1.2. slugs-distintos-entre-uploads

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos duas vezes seguidas com o mesmo body válido
    - expect: ambos retornam `201`
    - expect: os dois `slug`s são diferentes e os dois `id`s são diferentes

### 2. Rejeições de entrada e de autenticação

**Setup:** igual ao grupo 1.

#### 2.1. content-type-nao-video-retorna-415

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos com body `{ "filename": "foto.png", "content_type": "image/png", "size_bytes": 1024 }`
    - expect: status `415`
    - expect: body `{ statusCode: 415, error: "UNSUPPORTED_VIDEO_TYPE", message }`
    - expect: nenhum registro em `videos`

#### 2.2. tamanho-acima-de-10gib-retorna-422

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos com body `{ "filename": "grande.mp4", "content_type": "video/mp4", "size_bytes": 10737418241 }`
    - expect: status `422`
    - expect: body com `error: "VIDEO_TOO_LARGE"`
    - expect: nenhum registro em `videos` e nenhum multipart aberto no bucket

#### 2.3. body-invalido-retorna-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos com body `{ "content_type": "video/mp4", "size_bytes": 1024 }` (sem `filename`)
    - expect: status `400` no envelope de validação do projeto
    - expect: nenhum registro em `videos`

#### 2.4. sem-token-retorna-401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos sem header `Authorization` e com body válido
    - expect: status `401`
    - expect: nenhum registro em `videos`
