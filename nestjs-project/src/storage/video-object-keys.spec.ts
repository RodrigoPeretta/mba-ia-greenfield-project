import { videoObjectKeys } from './video-object-keys';

describe('videoObjectKeys', () => {
  it('should group the original and the thumbnail under the video id prefix', () => {
    const videoId = '6f1c9c56-3a8e-4e0e-9a39-2f4b8f1d7c21';

    expect(videoObjectKeys(videoId)).toEqual({
      original: `videos/${videoId}/original`,
      thumbnail: `videos/${videoId}/thumbnail.jpg`,
    });
  });
});
