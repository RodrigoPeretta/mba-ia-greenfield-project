import {
  generateVideoSlug,
  VIDEO_SLUG_LENGTH,
  VIDEO_SLUG_PATTERN,
} from './slug.util';

describe('generateVideoSlug', () => {
  it('should produce an 11-char URL-safe base64url slug', () => {
    const slug = generateVideoSlug();

    expect(slug).toHaveLength(VIDEO_SLUG_LENGTH);
    expect(slug).toMatch(VIDEO_SLUG_PATTERN);
  });

  it('should not collide across 10,000 generations', () => {
    const slugs = new Set(
      Array.from({ length: 10_000 }, () => generateVideoSlug()),
    );

    expect(slugs.size).toBe(10_000);
    for (const slug of slugs) {
      expect(slug).toMatch(VIDEO_SLUG_PATTERN);
    }
  });
});
