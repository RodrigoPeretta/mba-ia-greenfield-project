# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/12 completed

### SI-03.1 — Infra: broker de fila, object storage e FFmpeg no ambiente Docker
- **Status:** completed
- **Tests:** no tests (Infra) — 6/6 ACs verificados manualmente (stack healthy, PONG, noeviction, bucket privado 403, minio-init idempotente, ffprobe/ffmpeg 5.1.9)
- **Observations:**
  - **CORS (desvio do mecanismo, per doc oficial MinIO via context7):** MinIO não implementa `PutBucketCors`; CORS é global via `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3001`. Verificado: preflight `204` e `Access-Control-Expose-Headers` inclui `Etag` e `Content-Range`.
  - **Multiparts incompletos (desvio do mecanismo):** a ação de lifecycle `AbortIncompleteMultipartUpload` não é suportada pelo MinIO; usada a limpeza nativa `MINIO_API_STALE_UPLOADS_EXPIRY=24h`. A reconciliação do SI-03.10 continua sendo a primeira linha de limpeza.
  - **Healthcheck do MinIO:** as imagens Chainguard são distroless (sem shell/curl); criado `docker/minio.Dockerfile` (minio + binário `mc` do minio-client, ambos fixados por digest) para `healthcheck: mc ready local`. `minio-init` roda um único comando (`mc mb --ignore-existing`); buckets do MinIO já nascem privados.
  - Variáveis de S3/fila adicionadas ao `.env.example` e ao `.env` local (gitignored); `MINIO_ROOT_USER/PASSWORD` derivam de `S3_ACCESS_KEY/S3_SECRET_KEY` por interpolação do Compose.
  - Ambiente do host: a porta 5432 estava ocupada por outro projeto (`adk-postgres-1`); o Rodrigo pausou os outros projetos para liberar.

### SI-03.2 — Configuração e StorageModule (clientes S3 interno/público)
- **Status:** completed
- **Tests:** 21 passing (4 suites); `tsc --noEmit` OK; ESLint OK nos arquivos do SI
- **Observations:**
  - `npm install` resolveu `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` em `^3.1161.0` (dentro do range `^3.1156.0` de `library-refs.md`).
  - **Semântica do MinIO ≠ AWS no abort:** `AbortMultipartUpload` é idempotente no MinIO (OK num abort repetido e até para `UploadId` inexistente; verificado empiricamente), enquanto a AWS responde `NoSuchUpload`. O service mapeia `NoSuchUpload` para `false` (caminho AWS); o teste afirma só o que vale nos dois: abort repetido não lança. `ListParts` após abort responde `NoSuchUpload` nos dois (AC verificado).
  - Fix loop: 1 tentativa — teste com premissa AWS no abort duplicado + erro de tipo `Buffer` → `fetch` body (TS `BodyInit`), resolvido com `Uint8Array.from`.
  - `VIDEO_UPLOAD_PART_SIZE_BYTES` validado com mínimo de 5 MiB (mínimo de parte do S3) — restrição extra, coerente com TD-02.
  - Aviso do Node no Jest (`--localstorage-file was provided without a valid path`) é pré-existente e não afeta os testes; fora do escopo.

### SI-03.3 — Entidade Video, migration e gerador de slug
- **Status:** completed
- **Tests:** 74 passing (14 suites: 4 do SI + 10 suites existentes afetadas pela relação `Channel.videos`); `tsc --noEmit` OK; ESLint 0 erros
- **Observations:**
  - Migration `1793820510679-CreateVideos` gerada pela CLI (`migration:generate`) contra o banco no estado das 2 migrations anteriores; AC de run/revert verificado também pela CLI no banco de dev (cria e remove tabela + enum `video_status`).
  - A relação nos dois lados (`Channel.videos`) exigiu incluir `Video` no array `ALL_ENTITIES` de 10 specs existentes (auth, channels, users) e `DELETE FROM "videos"` no `cleanAllTables`. **Follow-up fora de escopo:** esse array está duplicado em 10+ arquivos; centralizá-lo no `src/test/create-test-data-source.ts` evitaria o mesmo ajuste a cada nova entidade.
  - Colunas de data do `Video` usam `timestamptz` (conforme o Data Model); as entidades das fases 01–02 usam `timestamp` sem fuso — divergência pré-existente, não alterada.
  - Avisos pré-existentes fora do escopo: `pg` `DeprecationWarning` (client.query concorrente) nas suites de DB e 23 warnings `no-unsafe-argument` em `auth.service*.spec`.

### SI-03.4 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- **Status:** completed
- **Tests:** 31 passing (25 em 4 suites unit/integration + 6 no e2e `test/videos-initiate-upload.e2e-spec.ts`); `tsc --noEmit` OK; ESLint 0 erros nos arquivos do SI
- **Observations:**
  - **MinIO não lista multiparts por prefixo:** `ListMultipartUploads` só devolve uploads quando o `Prefix` é a chave exata (verificado empiricamente). A limpeza dos testes aborta os multiparts a partir dos `upload_id` gravados em `videos`, e o "nenhum multipart aberto" do cenário 2.2 do spec é garantido pela ordem do service (tipo/tamanho validados antes de tocar DB e storage), coberto no unit test e pela ausência de registro no e2e.
  - Criado `test/helpers/videos-e2e.helpers.ts` (bootstrap com pipe/filtros do `main.ts`, reset de storage/tabelas/throttler e usuário confirmado com login) para reuso nos e2e de SI-03.5, SI-03.6 e SI-03.11.
  - `videos.module.spec.ts` (SI-03.3) atualizado: o módulo agora importa `StorageModule`/`ChannelsModule` e precisa do `ConfigModule` global com `storage`/`videos`.
  - `ChannelsService` já era exportado por `ChannelsModule`; só `findByUserId` foi acrescentado. Usuário sem canal gera `Error` genérico (500), pois o Error Catalog não prevê esse caso e todo usuário nasce com canal.
  - **Follow-up fora de escopo:** a detecção de violação `23505` por coluna está duplicada entre `channels.service.ts` e `video-uploads.service.ts`; vale extrair para um util comum.

### SI-03.5 — Endpoints de partes do upload: URLs assinadas, retomada e cancelamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint POST /videos/:id/upload/complete e publicação do job de processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Infra: entrypoint e container do video worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Serviço de mídia: extração de metadados e thumbnail com ffprobe/ffmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Processor do job process-video (metadados, thumbnail e status terminal)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Reconciliação de processamento e limpeza de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoints GET /videos/:slug, /stream e /download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Contrato OpenAPI exportado e requisições de exemplo
- **Status:** pending
- **Tests:** —
- **Observations:** none
