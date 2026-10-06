import { DEFAULT_VOICE_PROFILE_CONFIG, VoiceProfileConfig, type CreateVoiceProfileInput, type VoiceProfileView } from '@docengine/core';
import type { Database, Prisma, Tx, VoiceProfile } from '@docengine/database';
import type { VoiceProvider } from '@docengine/providers';

/**
 * Voice profiles: everything that shapes a take — provider, voice, model,
 * language, output format, voice settings, performance strategy, chunking,
 * context, number style. A profile is never edited: a change is a new
 * version (the old one is kept, inactive), so a take always points at the
 * exact configuration that made it.
 */

export const HOUSE_PROFILE = 'House narrator';

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/** Output formats the engine can measure and join without transcoding: MP3 (rate and bitrate), WAV or PCM (rate). */
export const OUTPUT_FORMAT = /^(mp3_\d+_\d+|wav_\d+|pcm_\d+)$/;

export const profileConfig = (p: Pick<VoiceProfile, 'config'>): VoiceProfileConfig => {
  const r = VoiceProfileConfig.safeParse(p.config);
  if (r.success) return r.data;
  // Older or partial configs: fill from the defaults, field by field.
  const c = (p.config ?? {}) as Partial<VoiceProfileConfig>;
  return VoiceProfileConfig.parse({
    ...DEFAULT_VOICE_PROFILE_CONFIG,
    ...c,
    settings: { ...DEFAULT_VOICE_PROFILE_CONFIG.settings, ...(c.settings ?? {}) },
    context: { ...DEFAULT_VOICE_PROFILE_CONFIG.context, ...(c.context ?? {}) },
  });
};

/** The active profile for the configured provider and a language, created from the configured defaults the first time. */
export async function activeProfile(db: Database | Tx, provider: VoiceProvider, language: string, actor = 'system'): Promise<VoiceProfile> {
  const found = await db.voiceProfile.findFirst({ where: { provider: provider.info.name, language, active: true }, orderBy: { createdAt: 'desc' } });
  if (found) return found;
  const voiceId = provider.defaults.voiceId;
  if (!voiceId) throw new ProfileError(`No voice chosen for ${provider.info.name}: set ELEVENLABS_VOICE_ID, or create a voice profile with a voice id`);
  const last = await db.voiceProfile.findFirst({ where: { name: HOUSE_PROFILE }, orderBy: { version: 'desc' }, select: { version: true } });
  return db.voiceProfile.create({
    data: {
      name: HOUSE_PROFILE,
      version: (last?.version ?? 0) + 1,
      provider: provider.info.name,
      voiceId,
      modelId: provider.defaults.model,
      language,
      outputFormat: provider.defaults.outputFormat,
      config: DEFAULT_VOICE_PROFILE_CONFIG as unknown as Prisma.InputJsonValue,
      active: true,
      notes: `Created from the configured defaults (${provider.info.name})`,
      createdBy: actor,
    },
  });
}

/** A new version of a profile (the configured provider only); it becomes the active one. */
export async function createProfileVersion(db: Database, provider: VoiceProvider, language: string, input: CreateVoiceProfileInput, actor: string): Promise<VoiceProfile> {
  return db.$transaction(async (tx) => {
    const base = input.basedOn ? await tx.voiceProfile.findUnique({ where: { id: input.basedOn } }) : await activeProfile(tx, provider, language, actor).catch(() => null);
    if (input.basedOn && !base) throw new ProfileError(`Voice profile ${input.basedOn} not found`);
    if (base && base.provider !== provider.info.name) throw new ProfileError(`Profile ${base.name} v${base.version} is for ${base.provider}; the configured voice provider is ${provider.info.name}`);
    const voiceId = input.voiceId ?? base?.voiceId ?? provider.defaults.voiceId;
    if (!voiceId) throw new ProfileError('A voice id is needed');
    const outputFormat = input.outputFormat ?? base?.outputFormat ?? provider.defaults.outputFormat;
    if (!OUTPUT_FORMAT.test(outputFormat)) throw new ProfileError(`Output format "${outputFormat}" cannot be measured or joined here: use an mp3_*, wav_* or pcm_* format (e.g. mp3_44100_128)`);
    const config = base ? profileConfig(base) : DEFAULT_VOICE_PROFILE_CONFIG;
    const next: VoiceProfileConfig = VoiceProfileConfig.parse({
      settings: { ...config.settings, ...(input.settings ?? {}) },
      strategy: input.strategy ?? config.strategy,
      chunking: input.chunking ?? config.chunking,
      context: input.context ?? config.context,
      numberStyle: input.numberStyle ?? config.numberStyle,
    });
    const name = input.name ?? base?.name ?? HOUSE_PROFILE;
    const last = await tx.voiceProfile.findFirst({ where: { name }, orderBy: { version: 'desc' }, select: { version: true } });
    await tx.voiceProfile.updateMany({ where: { provider: provider.info.name, language, active: true }, data: { active: false } });
    return tx.voiceProfile.create({
      data: {
        name,
        version: (last?.version ?? 0) + 1,
        provider: provider.info.name,
        voiceId,
        modelId: input.modelId ?? base?.modelId ?? provider.defaults.model,
        language,
        outputFormat,
        config: next as unknown as Prisma.InputJsonValue,
        active: true,
        notes: input.notes ?? (base ? `Based on ${base.name} v${base.version}` : null),
        createdBy: actor,
      },
    });
  });
}

export function toProfileView(p: VoiceProfile, runs: number, voiceName: string | null = null): VoiceProfileView {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    provider: p.provider,
    voiceId: p.voiceId,
    voiceName,
    modelId: p.modelId,
    language: p.language,
    outputFormat: p.outputFormat,
    config: profileConfig(p),
    active: p.active,
    notes: p.notes,
    createdAt: p.createdAt.toISOString(),
    runs,
  };
}
