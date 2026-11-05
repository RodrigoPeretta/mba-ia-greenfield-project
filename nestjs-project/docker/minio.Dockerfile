# MinIO server image with the `mc` binary added for the Compose healthcheck.
# Both Chainguard images are distroless (no shell, no curl), so `mc ready`
# is the only way to probe readiness from inside the container.
FROM cgr.dev/chainguard/minio-client@sha256:d8a93c5d335509ff353774eefec8f82fa2a2a975e800139702232d8be3dbe6b9 AS mc

FROM cgr.dev/chainguard/minio@sha256:c93745c56fccdaf0e5dcb88999a96a65a136428beb045ef5d546255a80d747a7

COPY --from=mc /usr/bin/mc /usr/bin/mc
