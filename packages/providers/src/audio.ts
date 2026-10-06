import { encodeWav, parseWav } from './mock/wav.ts';
import type { AudioMetadata } from './voice.ts';

/**
 * Just enough audio handling for narration — no transcoding, no decoding:
 * measure an MP3 or WAV file's duration from its frames or samples, join
 * clips of the same format, and put silence between them. MP3 clips are
 * joined frame by frame (ID3 and Xing/Info headers dropped) and silence is
 * written as empty MPEG frames of the clips' own format; WAV clips are joined
 * sample by sample.
 */

export class AudioFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioFormatError';
  }
}

// ── MP3 (MPEG audio layer III) ───────────────────────────────────────────────

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface FrameHeader {
  version: number; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  samples: number;
  length: number;
  crc: boolean;
}

function frameHeader(b: Uint8Array, i: number): FrameHeader | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1]! >> 3) & 3;
  const layer = (b[i + 1]! >> 1) & 3;
  const bitrateIndex = (b[i + 2]! >> 4) & 0xf;
  const rateIndex = (b[i + 2]! >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrateKbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[version]![rateIndex]!;
  const padding = (b[i + 2]! >> 1) & 1;
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrateKbps * 1000) / sampleRate) + padding;
  return { version, bitrateKbps, sampleRate, channels: ((b[i + 3]! >> 6) & 3) === 3 ? 1 : 2, samples, length, crc: (b[i + 1]! & 1) === 0 };
}

/** Xing/Info (or VBRI) metadata frame: describes the file, holds no audio worth keeping when files are joined. */
function isInfoFrame(b: Uint8Array, i: number, h: FrameHeader): boolean {
  const side = h.version === 3 ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
  const at = i + 4 + (h.crc ? 2 : 0) + side;
  const tag = String.fromCharCode(...b.subarray(at, at + 4));
  const vbri = String.fromCharCode(...b.subarray(i + 36, i + 40));
  return tag === 'Xing' || tag === 'Info' || vbri === 'VBRI';
}

export interface Mp3Info {
  frames: number;
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
  durationMs: number;
  /** Byte ranges of the audio frames (Xing/Info frame and tags excluded). */
  ranges: { start: number; end: number }[];
  /** The first audio frame's header (a template for silent frames). */
  header: Uint8Array;
}

function skipId3(b: Uint8Array): number {
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    return 10 + size + ((b[5]! & 0x10) !== 0 ? 10 : 0);
  }
  return 0;
}

export function parseMp3(b: Uint8Array): Mp3Info {
  let i = skipId3(b);
  let end = b.length;
  if (end - i >= 128 && b[end - 128] === 0x54 && b[end - 127] === 0x41 && b[end - 126] === 0x47) end -= 128; // ID3v1 "TAG"
  let frames = 0;
  let samples = 0;
  let first: FrameHeader | null = null;
  let header: Uint8Array | null = null;
  const ranges: { start: number; end: number }[] = [];
  let checkedInfo = false;
  while (i + 4 <= end) {
    const h = frameHeader(b, i);
    if (!h || i + h.length > end) {
      i++; // resynchronise on the next frame header
      continue;
    }
    if (!checkedInfo) {
      checkedInfo = true;
      if (isInfoFrame(b, i, h)) {
        i += h.length;
        continue;
      }
    }
    if (!first) {
      first = h;
      header = b.slice(i, i + 4);
    } else if (h.sampleRate !== first.sampleRate || h.channels !== first.channels) {
      throw new AudioFormatError('MP3 changes sample rate or channels mid-stream');
    }
    const last = ranges.at(-1);
    if (last && last.end === i) last.end = i + h.length;
    else ranges.push({ start: i, end: i + h.length });
    frames++;
    samples += h.samples;
    i += h.length;
  }
  if (!first || !header) throw new AudioFormatError('No MPEG audio frames found');
  return { frames, sampleRate: first.sampleRate, channels: first.channels, bitrateKbps: first.bitrateKbps, durationMs: Math.round((samples / first.sampleRate) * 1000), ranges, header };
}

/** An empty frame (no audio data: decodes to silence) in the format of `header`. */
function silentFrame(header: Uint8Array): Uint8Array {
  const h = new Uint8Array(header);
  h[1] = h[1]! | 0x01; // no CRC
  h[2] = h[2]! & ~0x02; // no padding
  const info = frameHeader(h, 0)!;
  const frame = new Uint8Array(info.length);
  frame.set(h, 0);
  return frame;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── Joining clips ────────────────────────────────────────────────────────────

export interface AudioClip {
  audio: Uint8Array;
  mimeType: string;
  /** Silence after the clip. */
  gapAfterMs: number;
}

export interface JoinedAudio {
  audio: Uint8Array;
  mimeType: string;
  durationMs: number;
  /** Where each clip starts in the joined audio (as written: frame-accurate for MP3). */
  startsMs: number[];
}

const isMp3 = (mime: string) => mime === 'audio/mpeg' || mime === 'audio/mp3';
const isWav = (mime: string) => mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave';

/** Joins clips of one format (MP3 or 16-bit PCM WAV) with silence between them. */
export function joinClips(clips: readonly AudioClip[]): JoinedAudio {
  if (!clips.length) throw new AudioFormatError('Nothing to join');
  const mime = clips[0]!.mimeType;
  if (clips.some((c) => c.mimeType !== mime)) throw new AudioFormatError('Clips of different formats cannot be joined without transcoding');
  if (isMp3(mime)) return joinMp3(clips);
  if (isWav(mime)) return joinWav(clips);
  throw new AudioFormatError(`Cannot join ${mime} audio (MP3 or WAV only)`);
}

function joinMp3(clips: readonly AudioClip[]): JoinedAudio {
  const parts: Uint8Array[] = [];
  const startsMs: number[] = [];
  let samples = 0;
  let rate = 0;
  let channels = 0;
  // Where the next clip belongs (the clips' measured lengths plus the silence asked for): silence is written in whole
  // frames, so each gap is rounded against this clock rather than on its own, and no clip drifts more than half a frame.
  let clockMs = 0;
  for (const c of clips) {
    const info = parseMp3(c.audio);
    if (!rate) {
      rate = info.sampleRate;
      channels = info.channels;
    } else if (info.sampleRate !== rate || info.channels !== channels) throw new AudioFormatError('MP3 clips differ in sample rate or channels');
    startsMs.push(Math.round((samples / rate) * 1000));
    for (const r of info.ranges) parts.push(c.audio.subarray(r.start, r.end));
    const perFrame = frameHeader(info.header, 0)!.samples;
    samples += info.frames * perFrame;
    clockMs += info.durationMs + c.gapAfterMs;
    if (c.gapAfterMs > 0) {
      const frame = silentFrame(info.header);
      const count = Math.max(0, Math.round(((clockMs / 1000) * rate - samples) / perFrame));
      for (let k = 0; k < count; k++) parts.push(frame);
      samples += count * perFrame;
    }
  }
  return { audio: concatBytes(parts), mimeType: 'audio/mpeg', durationMs: Math.round((samples / rate) * 1000), startsMs };
}

function joinWav(clips: readonly AudioClip[]): JoinedAudio {
  const pcm: Int16Array[] = [];
  const startsMs: number[] = [];
  let rate = 0;
  let total = 0;
  for (const c of clips) {
    const info = parseWav(c.audio);
    if (info.bitDepth !== 16 || info.channels !== 1) throw new AudioFormatError('Only 16-bit mono WAV clips can be joined');
    if (!rate) rate = info.sampleRate;
    else if (info.sampleRate !== rate) throw new AudioFormatError('WAV clips differ in sample rate');
    startsMs.push(Math.round((total / rate) * 1000));
    const data = wavData(c.audio);
    pcm.push(data);
    total += data.length;
    const gap = Math.round((c.gapAfterMs / 1000) * rate);
    if (gap > 0) {
      pcm.push(new Int16Array(gap));
      total += gap;
    }
  }
  const all = new Int16Array(total);
  let at = 0;
  for (const p of pcm) {
    all.set(p, at);
    at += p.length;
  }
  return { audio: encodeWav(all, rate), mimeType: 'audio/wav', durationMs: Math.round((total / rate) * 1000), startsMs };
}

/** The 16-bit samples of a PCM WAV file. */
function wavData(bytes: Uint8Array): Int16Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = v.getUint32(offset + 4, true);
    if (id === 'data') {
      const copy = bytes.slice(offset + 8, offset + 8 + size);
      return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 2));
    }
    offset += 8 + size + (size % 2);
  }
  throw new AudioFormatError('WAV file has no data chunk');
}

/** Raw 16-bit little-endian mono PCM (as some providers return it) wrapped in a WAV header. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const copy = pcm.slice(0, pcm.length - (pcm.length % 2));
  return encodeWav(new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2), sampleRate);
}

/** Duration and format of an MP3 or WAV file, measured from the file itself. */
export function audioMetadata(audio: Uint8Array, mimeType: string): AudioMetadata {
  if (isMp3(mimeType)) {
    const m = parseMp3(audio);
    return { durationMs: m.durationMs, sampleRate: m.sampleRate, channels: m.channels, format: 'mp3' };
  }
  if (isWav(mimeType)) {
    const w = parseWav(audio);
    return { durationMs: w.durationMs, sampleRate: w.sampleRate, channels: w.channels, bitDepth: w.bitDepth, format: 'wav' };
  }
  throw new AudioFormatError(`Cannot measure ${mimeType} audio (MP3 or WAV only)`);
}
