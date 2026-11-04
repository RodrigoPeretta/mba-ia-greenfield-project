---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-24T22:03:36-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24T22:01:35-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-01 decides BullMQ/@nestjs/bullmq but its Libraries field is empty"
    resolved_by: phase-03-videos/TD-01
  - id: AMB-1
    status: resolved
    summary: "Who may stream/download a video in Phase 03 (no publication yet)"
    resolved_by: phase-03-videos/TD-09
  - id: MD-1
    status: resolved
    summary: "No TD chooses the S3 client library used by API and worker"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-1
    status: resolved
    summary: "TD-01 leaves queue broker image open (Redis 8 vs Valkey)"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-12 pending — S3 Client Library for API and Worker"
    resolved_by: phase-03-videos/TD-12
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI Inventory deferred — check not applicable.)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-12)_ — No TD chose the S3 client library used by API and worker; `/research` added TD-12 to the phase doc, and the capability gap no longer fires (the pending decision is tracked as OQ-2).
- **IC-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decides BullMQ/@nestjs/bullmq but its Libraries field was empty. Revision appended to TD-01 (same option A): `**Libraries:** @nestjs/bullmq, bullmq`.
- **AMB-1** _(resolved_by phase-03-videos/TD-09)_ — Who may stream/download a video in Phase 03. Revision appended to TD-09 (same option A): owner only (JWT guard + ownership, others get 404), `ready` videos only; Phase 04 reopens the rule.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Queue broker image. Revision appended to TD-01: Valkey 8; tag `valkey/valkey:8.1-alpine` pinned in `library-refs.md`.
- **OQ-2** _(resolved_by phase-03-videos/TD-12)_ — TD-12 decided: A (AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, clients with checksum `WHEN_REQUIRED`); Libraries recorded and cached in `library-refs.md`.
