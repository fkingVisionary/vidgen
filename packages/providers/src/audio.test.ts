import { describe, expect, it } from 'vitest';
import { AudioFormatError, audioMetadata, joinClips, parseMp3, pcmToWav } from './audio.ts';
import { encodeWav } from './mock/wav.ts';

/** Measuring and joining narration clips without decoding or transcoding. */

const FRAME = 417; // MPEG-1 layer III, 128 kbps, 44.1 kHz, no padding
function mp3(frames: number, opts: { id3?: boolean; xing?: boolean } = {}): Uint8Array {
  const parts: number[] = [];
  if (opts.id3) parts.push(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0));
  const frame = (info: boolean) => {
    const f = new Array(FRAME).fill(0);
    f[0] = 0xff;
    f[1] = 0xfb;
    f[2] = 0x90;
    f[3] = 0xc4;
    if (info) [...'Xing'].forEach((c, i) => (f[4 + 17 + i] = c.charCodeAt(0)));
    return f;
  };
  if (opts.xing) parts.push(...frame(true));
  for (let i = 0; i < frames; i++) parts.push(...frame(false));
  return new Uint8Array(parts);
}

describe('MP3', () => {
  it('measures duration from the frames, skipping ID3 tags and the Xing/Info frame', () => {
    const m = parseMp3(mp3(100, { id3: true, xing: true }));
    expect(m).toMatchObject({ frames: 100, sampleRate: 44100, channels: 1, bitrateKbps: 128, durationMs: 2612 });
    expect(audioMetadata(mp3(38), 'audio/mpeg').durationMs).toBe(993);
    expect(() => parseMp3(new Uint8Array(500))).toThrow(AudioFormatError);
  });

  it('joins clips frame by frame with silent frames for the pauses between them', () => {
    const joined = joinClips([
      { audio: mp3(100, { xing: true }), mimeType: 'audio/mpeg', gapAfterMs: 1000 },
      { audio: mp3(50, { id3: true }), mimeType: 'audio/mpeg', gapAfterMs: 0 },
    ]);
    const parsed = parseMp3(joined.audio);
    // 100 + 38 silent (1 s at 26.1 ms a frame) + 50 frames; no tags or Xing frame in the middle.
    expect(parsed.frames).toBe(188);
    expect(joined.durationMs).toBe(parsed.durationMs);
    expect(joined.startsMs).toEqual([0, 3605]);
  });

  it('refuses to join different formats (no transcoding)', () => {
    expect(() => joinClips([{ audio: mp3(5), mimeType: 'audio/mpeg', gapAfterMs: 0 }, { audio: encodeWav(new Int16Array(10), 22050), mimeType: 'audio/wav', gapAfterMs: 0 }])).toThrow(/different formats/);
  });
});

describe('WAV', () => {
  it('joins 16-bit mono clips sample by sample, with silence, and wraps raw PCM', () => {
    const a = encodeWav(new Int16Array(22050).fill(1000), 22050);
    const b = pcmToWav(new Uint8Array(new Int16Array(11025).fill(-1000).buffer), 22050);
    const joined = joinClips([
      { audio: a, mimeType: 'audio/wav', gapAfterMs: 500 },
      { audio: b, mimeType: 'audio/wav', gapAfterMs: 0 },
    ]);
    expect(joined).toMatchObject({ mimeType: 'audio/wav', durationMs: 2000, startsMs: [0, 1500] });
    expect(audioMetadata(joined.audio, 'audio/wav')).toMatchObject({ durationMs: 2000, sampleRate: 22050, channels: 1, bitDepth: 16 });
  });
});
