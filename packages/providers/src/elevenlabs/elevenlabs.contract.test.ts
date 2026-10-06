import { runVoiceContract } from '../contract/index.ts';
import { ElevenLabsVoiceProvider } from './elevenlabs.ts';

/**
 * The shared VoiceProvider contract, run against ElevenLabs on a fake
 * endpoint (no key, no network, no credits): the same suite the MOCK passes.
 */

const FRAME_MS = 1152 / 44.1;

/** MPEG-1 layer III frames (128 kbps, 44.1 kHz, mono) lasting at least `ms`. */
function mp3For(ms: number): Uint8Array {
  const frames = Math.ceil(ms / FRAME_MS) + 1;
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  const out = new Uint8Array(417 * frames);
  for (let i = 0; i < frames; i++) out.set(frame, i * 417);
  return out;
}

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

/** Speaks every character in 50 ms and answers like the convert-with-timestamps endpoint. */
const fakeElevenLabs: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (init?.method === 'GET' && url.pathname === '/v2/voices') return json({ voices: [{ voice_id: 'contract-voice', name: 'Contract narrator' }], has_more: false, total_count: 1 });
  if (init?.method === 'POST' && url.pathname === '/v1/text-to-speech/contract-voice/with-timestamps') {
    const { text } = JSON.parse(String(init.body)) as { text: string };
    const chars = [...text];
    return json(
      {
        audio_base64: Buffer.from(mp3For(chars.length * 50)).toString('base64'),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.05) },
      },
      { 'request-id': 'contract-req', 'character-cost': String(text.length) },
    );
  }
  return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
};

runVoiceContract('elevenlabs (fake endpoint)', () => new ElevenLabsVoiceProvider({ apiKey: 'contract-test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128', fetch: fakeElevenLabs }), 'contract-voice');
