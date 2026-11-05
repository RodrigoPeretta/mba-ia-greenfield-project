// Loaded after `dotenv/config` in both Jest configs, so these values win over `.env`.

// Tests run inside the `nestjs-api` container, where `localhost:9000` is the container
// itself; SigV4 binds the signature to the host, so public URLs must be signed for a
// host the tests can reach.
process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';

// Keeps jobs created by tests away from the running `video-worker` (default prefix).
process.env.QUEUE_PREFIX = 'bull-test';
