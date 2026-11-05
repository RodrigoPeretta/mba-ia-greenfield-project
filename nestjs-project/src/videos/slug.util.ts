import { randomBytes } from 'crypto';

export const VIDEO_SLUG_LENGTH = 11;
export const VIDEO_SLUG_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** 64 random bits encoded as base64url: exactly 11 URL-safe chars, non-enumerable. */
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url').slice(0, VIDEO_SLUG_LENGTH);
}
