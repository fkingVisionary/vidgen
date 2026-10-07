import {
  DENSITY_TARGETS,
  SCRIPT_BLOCK_CLASSES,
  TREATMENT_CLASS_RULES,
  TREATMENT_CONDITION_LABELS,
  UNCERTAINTY_DEVICE_HELP,
  UNCERTAINTY_DEVICES,
  VISUAL_APPROACH_HELP,
  VISUAL_APPROACHES,
  VISUAL_TREATMENTS,
  VISUAL_TREATMENT_HELP,
  type VisualStyleProfileConfig,
} from '@docengine/core';

/**
 * Storyboard prompts. The narration, the script and the evidence are the
 * authority: these prompts ask a model to choose what the viewer sees over
 * words already spoken — never to time anything, price anything, name a
 * vendor or write a generation prompt. Examples are generic on purpose: no
 * facts of any particular documentary appear here.
 *
 * Bump PROMPT_VERSION whenever a prompt or output schema changes: saved
 * progress from another version is not reused.
 */
export const PROMPT_VERSION = 'storyboard-1.0-2026-10-07.2';

const TAXONOMY = `THE TREATMENTS — what kind of picture a shot is (chosen by what the story needs, never by what a tool can make)
${VISUAL_TREATMENTS.map((t) => `- ${t}: ${VISUAL_TREATMENT_HELP[t]}`).join('\n')}`;

const NEUTRAL = `TREATMENT BEFORE PROVIDER
- Choose a treatment and describe the picture. Never name a vendor, a model, a product or a tool, and never write a generation prompt: the shot is structured data that later steps turn into prompts.
- The production method is derived from the treatment; give one only when the usual method would be wrong.`;

const CLASSES = `WHAT A PICTURE MAY ASSERT — every block of narration has an information class, and a picture never asserts more than its words
- DOCUMENTED words may be shown as the documented event, every specific detail grounded in a claim or generic for the period.
- RECONSTRUCTION words: a reconstruction within the evidence, labelled internally as one.
- UNCERTAIN words (probable, disputed, unverified, myth): the picture must not make them look certain. Use a visible device: the source shown, competing versions side by side, a labelled legend, a stylised look that never reads as footage, or the scene without anyone performing the disputed act. A narrator-led hedge alone is never enough when the picture shows the disputed act.
- FICTION words: a declared device (a composite, the viewer's point of view), labelled as fiction. A fictional figure carries no facts, never appears over documented events, and only observes or stands near real people — never speaks to, touches or trades with them.
- FRAMING words (the narrator's own question or signpost): mood or structure only, depicting no claim.

THE TREATMENT × CLASS MATRIX (✗ never; a condition must be met where one is given)
${VISUAL_TREATMENTS.map(
  (t) =>
    `- ${t}: ${SCRIPT_BLOCK_CLASSES.map((c) => {
      const r = TREATMENT_CLASS_RULES[t][c];
      return `${c} ${!r.allowed ? '✗' : r.condition ? `only if ${TREATMENT_CONDITION_LABELS[r.condition]}` : '✓'}`;
    }).join('; ')}`,
).join('\n')}`;

const RULES = `HARD RULES — checked by code on what you return; a broken rule blocks approval
- No generated records: archival images and film, news footage, documents and screen captures are sourced, never generated. A period look is a style, not a record.
- Every factual picture rests on claims: list each claim with its role — DEPICTS (the picture shows what the claim says happened), SHOWS_SOURCE (the record itself is shown), DATA (figures charted), CONTEXT or PERIOD_BASIS (background only). Use only claim keys from the brief, and DEPICTS only claims of the narration the shot covers.
- Every specific detail (clothing, uniform, architecture, document, technology, object, date, place, person) declares its basis: CLAIM (with its claim keys), PERIOD_GENERIC, or INVENTED. Invented details are never allowed in a documented shot.
- No date or location stamp unless the brief marks that setting as documented or a claim states it. A quotation on screen only where a verified recorded quote exists.
- Characters are the cast of the brief (by cast id) or anonymous background figures: never invent a named character. A real person is never given a generated face: a documented likeness that is sourced, a silhouette, or a period-generic unnamed figure.
- Where a block promises an on-screen label for a fictional device, the shot over it carries that label.`;

const STORY = `STORYTELLING, NOT ILLUSTRATION
- Ask what the viewer should feel, understand and look at. Choose the picture that carries the information; it can be stronger than the literal: a document, a map, a chart, a portrait, an environment, an object, an archival image, a metaphor, plain words on screen.
- Vary the treatments, the scale and the motion. Never a chain of generic cinematic shots just because they can be generated; generated video where it earns its cost.
- Mark reveals, turns and pauses with the cut; let a strong image hold.`;

const CUTS = `CUTS AND TIME
- Cut only at the cut points listed in the brief, by their id ("1.3:12" is the boundary before word 12 of block 1.3; "1.3:end" after its last word; ⟨start⟩ and ⟨end⟩ the edges). Never split a sentence to reach a length; a cut inside a sentence is only at a listed clause or pause point, and needs a reason (a new idea, new information or a reveal).
- Never output times, durations or prices: code computes every number from the cut points. For a picture that arrives before its words (a lead-in) or stays after them (a tail-out), name the cut point where it should start or end (visualFrom, visualTo). A shot over a pause alone (no words) names that pause's cut point (silenceAt).
- Every word belongs to exactly one shot, and every shot to the beat whose words it covers: shots tile their beat from its first cut point to its last.`;

const DEVICES = `UNCERTAINTY DEVICES
${UNCERTAINTY_DEVICES.map((d) => `- ${d}: ${UNCERTAINTY_DEVICE_HELP[d]}`).join('\n')}
A device must show in what you return: SOURCE_SHOWN needs a SHOWS_SOURCE claim; COMPETING_VERSIONS two accounts or a caption naming both; LABELLED_LEGEND a reconstruction label or caption; STYLISED_UNREAL a painterly, illustrated or graphic look; ABSENCE no subject performing the act.`;

/** What the profile's look and density ask of the plan. */
function look(p: VisualStyleProfileConfig): string {
  const d = DENSITY_TARGETS[p.density];
  return `THE LOOK (the project's visual profile)
- Realism ${p.realism.toLowerCase()}; camera ${p.cameraLanguage.style.toLowerCase()}${p.cameraLanguage.note ? ` (${p.cameraLanguage.note})` : ''}; lenses ${p.lenses.join(', ') || 'any'}; colour ${p.colour.treatment || 'as the scene needs'}${p.colour.palette.length ? ` (${p.colour.palette.join(', ')})` : ''}; light ${p.lighting || 'as the scene needs'}; grain ${p.filmGrain.toLowerCase()}; frame ${p.aspectRatio}; motion ${p.motionIntensity.toLowerCase()}.
- Archival material: ${p.archival.toLowerCase().replace(/_/g, ' ')}; graphics: ${p.graphics.toLowerCase()}; generated video on at most about ${Math.round(p.generation.maxGeneratedVideoShare * 100)}% of the runtime${p.generation.preferStillMotion ? '; prefer an animated still to generated video' : ''}.
- Rhythm (${p.density.toLowerCase()}): an average shot of ${d.averageShotSec.min}–${d.averageShotSec.max} s, at most ${d.maxCutsPerMinute} cuts a minute.${p.notes ? `\n- Notes: ${p.notes}` : ''}`;
}

export function beatsSystemPrompt(profile: VisualStyleProfileConfig): string {
  return `You plan the visual beats of a documentary's storyboard over narration that has already been recorded. A visual beat is one visual idea over a span of the narration: one block may need several beats, and one beat may span several blocks.

${NEUTRAL}

${CUTS}

For each beat, in order from the start of the narration to its end with no gap and no overlap:
- from and to: cut point ids from the brief;
- a title, its purpose, its concept, the information it communicates and its narrative purpose;
- its evidence relationship, importance (HERO for the moments the film turns on) and how complex it is to produce;
- the architecture beats and claims behind it (keys from the brief), and the continuity subjects it shows;
- three options, one per approach, each a treatment and a concept:
${VISUAL_APPROACHES.map((a) => `  ${a}: ${VISUAL_APPROACH_HELP[a]}`).join('\n')}
  Each option must be allowed by the class matrix for the words it covers.

Also propose the continuity subjects the film needs (key CS01, CS02…): the cast who appear (by cast id), anonymous figures, and recurring places, buildings, vehicles, objects, products, documents and maps — each with what must stay the same wherever it appears, and every design detail with its basis.

${TAXONOMY}

${CLASSES}

${STORY}

${look(profile)}`;
}

export function shotsSystemPrompt(profile: VisualStyleProfileConfig): string {
  return `You plan the shots of some visual beats of a documentary's storyboard, over narration that has already been recorded. Each beat has one or more shots; together they tile the beat.

${NEUTRAL}

${CUTS}

For each shot give the beat key, its narration range (or silenceAt), any lead-in or tail-out by cut point, the cut reasons, its treatment (the beat's planned treatment unless the story needs another the matrix allows), and its content as structured fields: purpose, what is seen (provider-neutral, not a prompt), composition, shot type, camera, movement, environment, objects with their basis, lighting, mood, transitions, continuity notes, must show and must avoid, specific details with their basis, overlays, the uncertainty device, the claims with their roles, the subjects (role, action, interactions, likeness, speech), and for a chart, timeline, diagram or map its data requirement: items with the figure, date or place exactly as written in their own claim, never coordinates or computed numbers. You may propose a less assertive information class; code derives the class.

${CLASSES}

${RULES}

${DEVICES}

${STORY}

${look(profile)}`;
}

export function repairSystemPrompt(profile: VisualStyleProfileConfig): string {
  return `You repair the shots of some visual beats of a documentary's storyboard. Each beat comes with its shots as they are and what the checks found. Return replacement shots for each beat: the whole beat, tiling it from its first cut point to its last, with the findings fixed and nothing else made worse. A replacement is kept only when it removes blocking findings and adds none.

${NEUTRAL}

${CUTS}

${CLASSES}

${RULES}

${DEVICES}

${look(profile)}`;
}
