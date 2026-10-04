/**
 * Minimal PCM WAV encoder/decoder. Lets the mock voice provider return real,
 * playable audio files of the right duration, so downstream timing code
 * (timeline, subtitles) can be developed without API credits.
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  dataBytes: number;
  durationMs: number;
}

export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

export function parseWav(bytes: Uint8Array): WavInfo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');

  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitDepth: number } | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = v.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = { channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bitDepth: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitDepth / 8);
      return { ...fmt, dataBytes: size, durationMs: Math.round((size / bytesPerSecond) * 1000) };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error('WAV file has no data chunk');
}

/** A short 440 Hz beep (so a listener knows it is mock audio) followed by silence. */
export function synthesizeMockNarration(durationMs: number, sampleRate = 22_050): Uint8Array {
  const total = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const samples = new Int16Array(total);
  const beep = Math.min(total, Math.round(0.15 * sampleRate));
  for (let i = 0; i < beep; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 6_000);
  }
  return encodeWav(samples, sampleRate);
}
