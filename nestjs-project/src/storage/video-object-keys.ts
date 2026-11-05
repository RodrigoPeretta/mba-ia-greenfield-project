export interface VideoObjectKeys {
  original: string;
  thumbnail: string;
}

/** Immutable object keys grouped by video id, independent of user input. */
export const videoObjectKeys = (videoId: string): VideoObjectKeys => ({
  original: `videos/${videoId}/original`,
  thumbnail: `videos/${videoId}/thumbnail.jpg`,
});
