---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-upload-parts.e2e-spec.ts
---

# Upload parts (part-urls / parts / cancel) — Test Plan

## Application Overview

Três endpoints sobre um vídeo em `draft`, todos restritos ao dono (vídeo alheio ou inexistente → `404 VIDEO_NOT_FOUND`). `POST /videos/:id/upload/part-urls` assina, com o endpoint público (`S3_PUBLIC_ENDPOINT`), URLs `UploadPart` para as partes pedidas, válidas por `VIDEO_UPLOAD_URL_TTL_SECONDS`. O cliente envia os bytes direto ao storage. `GET /videos/:id/upload/parts` lista as partes já recebidas (`ListParts`), para retomar o upload sem reenviar partes. `DELETE /videos/:id/upload` aborta o multipart e remove o rascunho. Operações em vídeo fora de `draft` retornam `409 INVALID_VIDEO_STATE`; número de parte fora de `1..part_count`, `422 INVALID_PART_NUMBER`.

## Test Scenarios

### 1. URLs assinadas e retomada do upload

**Setup:** `beforeAll` sobe `AppModule` reproduzindo a configuração global de `main.ts` (`ValidationPipe` + filtros de exceção). `beforeEach` roda `cleanAllTables`, limpa o prefixo `videos/` do bucket, cria dois usuários confirmados (dono e outro), loga os dois e cria um rascunho do dono via `POST /videos` com `size_bytes: 157286400` (3 partes). Helper `putToPresignedUrl(url, body)`: envia o `PUT` direto para a URL assinada, sem reescrevê-la. Nas suítes do Jest, `test/setup-env.ts` fixa `S3_PUBLIC_ENDPOINT=http://minio:9000` (SI-03.2), então a URL pública já é alcançável de dentro do container e a assinatura SigV4 continua válida.

#### 1.1. part-urls-retorna-urls-publicas-com-ttl

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos/{id}/upload/part-urls como dono, com body `{ "part_numbers": [1, 2] }`
    - expect: status `200`
    - expect: `parts` com 2 itens `{ part_number, url }`, `part_number` 1 e 2
    - expect: cada `url` tem origem igual a `S3_PUBLIC_ENDPOINT` e contém `partNumber` e `uploadId` na query
    - expect: `expires_in: 3600`

#### 1.2. parte-enviada-aparece-na-listagem

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. Pedir a URL da parte 1 e chamar `putToPresignedUrl` com 5 MiB de bytes
    - expect: o storage responde `200` com header `ETag`
  2. GET /videos/{id}/upload/parts como dono
    - expect: status `200`
    - expect: `parts` igual a `[{ part_number: 1, etag: <ETag do passo 1>, size: 5242880 }]`
    - expect: `part_size: 67108864` e `part_count: 3`

#### 1.3. numero-de-parte-fora-do-intervalo-retorna-422

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos/{id}/upload/part-urls como dono, com body `{ "part_numbers": [999] }`
    - expect: status `422`
    - expect: body com `error: "INVALID_PART_NUMBER"`

#### 1.4. lista-de-partes-vazia-retorna-400

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos/{id}/upload/part-urls como dono, com body `{ "part_numbers": [] }`
    - expect: status `400` no envelope de validação do projeto

### 2. Cancelamento do upload

**Setup:** igual ao grupo 1.

#### 2.1. cancelar-aborta-multipart-e-remove-rascunho

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. Enviar a parte 1 (como no cenário 1.2) e guardar o `upload_id` do registro
  2. DELETE /videos/{id}/upload como dono
    - expect: status `204` com corpo vazio
    - expect: nenhum registro `videos` com esse `id`
  3. `ListParts` direto no storage com o `upload_id` guardado
    - expect: falha com `NoSuchUpload`
  4. GET /videos/{id}/upload/parts como dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

### 3. Isolamento por dono e validação de parâmetro

**Setup:** igual ao grupo 1.

#### 3.1. outro-usuario-recebe-404-nas-tres-rotas

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. POST /videos/{id}/upload/part-urls com o token do outro usuário e body `{ "part_numbers": [1] }`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/{id}/upload/parts com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  3. DELETE /videos/{id}/upload com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o rascunho do dono continua no banco, com `upload_id` intacto

#### 3.2. id-nao-uuid-retorna-400

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-04T18:40:13Z

**Steps:**
  1. GET /videos/not-a-uuid/upload/parts como dono
    - expect: status `400`
