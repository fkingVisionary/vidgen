// Browser QA of the Voice page at 360, 412 and 1280 px against the MOCK
// fixture (scripts/ui/voice-ui.sh starts it and runs this). It clicks: plan,
// generate an audition, play the assembled audio, regenerate one chunk (take
// 2 current, take 1 under earlier), approve, use the previous take, compare
// earlier takes and a comparison's variants; at 1280 also regenerate with
// directions, regenerate selected chunks, an A/B of one chunk, the acceptance
// experiment (planned again at 412 and 360) and a new profile version, which
// a confirmed plan is not moved to. On every width: no horizontal overflow,
// every button in a chunk card at least 24 px tall, generation state
// visible, no console errors.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3102';
const OUT = process.env.OUT ?? '/tmp/voice-ui';
const fixture = JSON.parse(process.env.FIXTURE ?? '{}');
if (!fixture.slug) throw new Error('FIXTURE (the fixture\'s READY line) is required');

function playwright() {
  const require = createRequire(import.meta.url);
  const global = (() => {
    try {
      return join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright');
    } catch {
      return null;
    }
  })();
  for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', global].filter(Boolean)) {
    try {
      return require(spec);
    } catch {}
  }
  throw new Error('Playwright not found: install it with Chromium, or set PLAYWRIGHT_MODULE');
}
const { chromium } = playwright();

const failures = [];
const problems = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
/** Polls until fn returns something truthy; a timeout stops this width's run. */
async function until(fn, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}
const text = (l) => l.innerText();
const overflow = async (page, where) => {
  const r = await page.evaluate(() => ({ W: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }));
  check(r.sw <= r.W, `${where}: no horizontal overflow (${r.sw}/${r.W})`);
};
const tapTargets = async (page, where) => {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('article button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) }))
      .filter((b) => b.h < 24),
  );
  check(!small.length, `${where}: every button in a chunk card is at least 24 px tall${small.length ? ` (${small.map((b) => `"${b.t}" ${b.h}px`).join(', ')})` : ''}`);
};
/** Loads an <audio>, plays it muted for a moment; its duration and whether time moved. */
const play = (audio) =>
  audio.evaluate(async (a) => {
    a.preload = 'metadata';
    a.muted = true;
    a.load();
    await new Promise((res) => {
      a.addEventListener('loadedmetadata', res, { once: true });
      a.addEventListener('error', res, { once: true });
      setTimeout(res, 8000);
    });
    let moved = false;
    try {
      await a.play();
      await new Promise((r) => setTimeout(r, 500));
      moved = a.currentTime > 0;
      a.pause();
    } catch {}
    return { duration: a.duration, moved, error: a.error ? a.error.code : null };
  });
const section = (page, heading) => page.locator('section', { has: page.getByRole('heading', { name: heading }) });

const browser = await chromium.launch();
async function open(width) {
  const viewport = { width, height: width < 600 ? 860 : 900 };
  const ctx = await browser.newContext(width < 600 ? { viewport, isMobile: true, hasTouch: true } : { viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${width}: ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${width}: pageerror: ${e.message}`));
  const plans = [];
  const created = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    if (r.url().endsWith('/voice/plan')) plans.push(JSON.parse(r.postData() ?? '{}'));
    if (/\/voice\/(runs|experiments)$/.test(r.url())) created.push(JSON.parse(r.postData() ?? '{}'));
  });
  return { page, plans, created };
}
const voiceUrl = (run) => `${BASE}/projects/${fixture.slug}/voice${run ? `?run=${run}` : ''}`;
async function goto(page, run) {
  await page.goto(voiceUrl(run));
  await page.getByRole('heading', { name: 'Voice', exact: true }).waitFor();
}

/** Plan and generate an audition from the Generate tab; returns the new run's number. */
async function planAndGenerate(page, plans, tag) {
  await page.getByRole('tab', { name: 'Audition & generate' }).click();
  check((await page.getByRole('tab', { name: 'Audition & generate' }).getAttribute('aria-selected')) === 'true', `${tag}: the open tab is marked selected`);
  const size = page.getByLabel('Chunk size (natural boundaries come first)');
  const sizes = await size.locator('option').allInnerTexts();
  check(/^Profile default \(\d+–\d+ words \(≈\d+–\d+ s\)\)$/.test(sizes[0]) && ['≈5–8 s', '≈8–12 s', '≈12–20 s'].every((s) => sizes.some((o) => o.startsWith(s))), `${tag}: chunk sizes are the profile default and ≈5–8 / 8–12 / 12–20 s (${sizes.join(' | ')})`);
  const compareOptions = await page.getByLabel('Generate as').locator('option').allInnerTexts();
  check(compareOptions.some((o) => /plain \/ restrained \/ expressive/.test(o)) && compareOptions.some((o) => /no context \/ neighbouring text/.test(o)) && compareOptions.some((o) => /≈5–8 \/ ≈8–12 \/ ≈12–20 s/.test(o)), `${tag}: direction, continuity and chunk-size comparisons offered`);
  await page.getByLabel('About how long (seconds, whole blocks)').fill('60');

  // A plan, then a comparison planned and confirmed — then the scope changes: plan and confirmation are gone.
  plans.length = 0;
  await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
  await page.getByRole('heading', { name: /^Plan — / }).waitFor();
  const sent = plans.at(-1)?.options ?? {};
  check(!('chunking' in sent) && !('strategy' in sent) && !('context' in sent), `${tag}: "Profile default" sends no chunking, strategy or context (${JSON.stringify(sent)})`);
  const rows = page.locator('li[data-plan-chunk]');
  const n = await rows.count();
  check(n >= 2, `${tag}: the plan lists its chunks (${n})`);
  let consistent = true;
  let numbered = true;
  for (let i = 0; i < n; i++) {
    const t = await text(rows.nth(i));
    const sec = Number(/≈(\d+(?:\.\d)?) s/.exec(t)?.[1] ?? NaN);
    if (!Number.isFinite(sec) || (sec < 5 || sec > 20) !== /outside 5–20 s/.test(t)) consistent = false;
    if ((await rows.nth(i).locator('sup[data-sentence]').count()) < 1) numbered = false;
  }
  check(consistent, `${tag}: every planned chunk shows its seconds, flagged exactly when outside 5–20 s`);
  check(numbered, `${tag}: planned chunks number their sentences`);
  await page.getByLabel('Generate as').selectOption('context');
  check((await page.getByRole('heading', { name: /^Plan — / }).count()) === 0, `${tag}: changing what is generated drops the plan`);
  await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
  await page.getByRole('heading', { name: /^Plan — Continuity, 2 variants/ }).waitFor();
  const confirm = page.getByRole('checkbox', { name: /I confirm all 2 runs/ });
  const generate = page.getByRole('button', { name: 'Generate the comparison (2 runs)' });
  check(!(await confirm.isChecked()) && (await generate.isDisabled()), `${tag}: a comparison needs its confirmation`);
  await confirm.check();
  check(await generate.isEnabled(), `${tag}: confirmed, the comparison can be generated`);
  await page.getByLabel('About how long (seconds, whole blocks)').fill('61');
  check((await page.getByRole('heading', { name: /^Plan — / }).count()) === 0 && (await generate.count()) === 0, `${tag}: changing the scope after a confirm clears the plan and the confirm`);
  await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
  await page.getByRole('heading', { name: /^Plan — Continuity/ }).waitFor();
  check(!(await confirm.isChecked()) && (await generate.isDisabled()), `${tag}: the new plan starts unconfirmed`);
  await overflow(page, `${tag} generate tab`);
  await page.screenshot({ path: `${OUT}/voice-${tag}-plan.png`, fullPage: true });

  // One run: plan it and generate (the MOCK audition needs no confirmation under the threshold).
  await page.getByLabel('Generate as').selectOption('none');
  await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
  await page.getByRole('heading', { name: /^Plan — Opening audition/ }).waitFor();
  await page.getByRole('button', { name: 'Generate the audition' }).click();
  await page.waitForURL(/[?&]run=\d+/);
  return Number(new URL(page.url()).searchParams.get('run'));
}

/** The run tab once every chunk has a take and the audition is assembled. */
async function generated(page, run) {
  await page.getByRole('heading', { name: new RegExp(`^Voice run ${run} — `) }).waitFor();
  await until(async () => {
    const cards = page.locator('article');
    if (!(await cards.count())) return false;
    const all = await cards.allInnerTexts();
    return all.every((t) => !/Not generated yet|\bPending\b|\bGenerating\b/.test(t)) && (await page.getByRole('heading', { name: /^Assembled narration v\d+/ }).count()) > 0;
  }, `run ${run} generated and assembled`, 60_000);
}

async function core(width) {
  const tag = String(width);
  const { page, plans, created } = await open(width);
  try {
    await goto(page);
    const run = await planAndGenerate(page, plans, tag);
    await generated(page, run);
    const assembly = section(page, /^Assembled narration v/);
    check(/To review/.test(await text(assembly)), `${tag}: the audition's assembly is to review`);
    const heard = await play(assembly.locator('audio').first());
    check(heard.duration > 0 && heard.moved, `${tag}: the assembled audio plays (${heard.duration?.toFixed?.(1)} s, playing ${heard.moved})`);
    const cards = page.locator('article');
    const n = await cards.count();
    check(n >= 2, `${tag}: chunk cards (${n})`);
    check(/To review/.test(await text(cards.nth(0))), `${tag}: a new take reads "To review"`);
    check((await cards.nth(0).locator('sup[data-sentence]').count()) >= 1, `${tag}: chunk cards number their sentences`);
    await tapTargets(page, `${tag} run tab`);

    // Regenerate chunk 1: take 2 becomes current, take 1 waits under the earlier takes.
    const first = cards.nth(0);
    await first.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await until(async () => (await first.locator('[data-take="2"][data-current="true"]').count()) === 1 && (await first.getByRole('button', { name: 'Compare 1 earlier take' }).count()) === 1, 'take 2 current');
    check(true, `${tag}: regenerating chunk 1 makes take 2 current`);
    check((await first.locator('[data-take="1"]').count()) === 0, `${tag}: take 1 is folded under the earlier takes`);
    const toggle = first.getByRole('button', { name: 'Compare 1 earlier take' });
    check((await toggle.getAttribute('aria-expanded')) === 'false', `${tag}: the earlier-takes toggle says it is collapsed`);
    await toggle.click();
    const one = first.locator('[data-take="1"]');
    check(/Superseded/.test(await text(one)) && (await one.getByRole('button', { name: 'Use this take' }).count()) === 1, `${tag}: compare: take 1 is superseded and can be used again`);
    const takeAudio = await play(one.locator('audio'));
    check(takeAudio.duration > 0, `${tag}: compare: the earlier take plays (${takeAudio.duration?.toFixed?.(1)} s)`);

    // Approve take 2, then go back to take 1.
    await first.locator('[data-take="2"]').getByRole('button', { name: 'Approve' }).click();
    await until(async () => /Approved/.test(await text(first.locator('[data-take="2"]'))), 'take 2 approved');
    check(true, `${tag}: approving take 2 shows it approved`);
    await first.locator('[data-take="1"]').getByRole('button', { name: 'Use this take' }).click();
    await until(async () => (await first.locator('[data-take="1"][data-current="true"]').count()) === 1, 'take 1 current again');
    check(/Superseded/.test(await text(first.locator('[data-take="2"]'))), `${tag}: "Use this take" makes take 1 current again, take 2 superseded`);
    await page.getByRole('heading', { name: /^Assembled narration v3 / }).waitFor();
    check((await page.getByRole('button', { name: 'Earlier versions (2)' }).count()) === 1, `${tag}: the assembly is rebuilt each time (v3, two earlier versions kept)`);
    await page.getByLabel('What is said at').fill('00:01');
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await until(async () => /0:01\.0 — SC01, block/.test(await page.locator('main').innerText()), 'what is said at 00:01', 5_000);
    check(true, `${tag}: "what is said at 00:01" answers`);
    await tapTargets(page, `${tag} run tab after review`);
    await overflow(page, `${tag} run tab`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-run.png`, fullPage: true });

    // The seeded direction comparison: every variant playable whole, and openable.
    const [a, b] = fixture.comparison;
    await goto(page, a);
    const comparison = section(page, /^Comparison “Performance direction” — 3 variants/);
    await until(async () => (await comparison.locator('audio').count()) === 3, 'three assembled variants', 15_000);
    check((await comparison.locator('[data-variant]').count()) === 3, `${tag}: the comparison shows its three variants`);
    const variant = await play(comparison.locator('[data-variant="C expressive"] audio'));
    check(variant.duration > 0, `${tag}: a variant plays whole (${variant.duration?.toFixed?.(1)} s)`);
    await comparison.getByRole('button', { name: `Open run ${b} to review its chunks` }).click();
    await page.getByRole('heading', { name: new RegExp(`^Voice run ${b} — .*B restrained`) }).waitFor();
    check(true, `${tag}: a variant opens as its run`);
    await overflow(page, `${tag} comparison`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-comparison.png`, fullPage: true });

    // Generation state: a take still generating and a failed one stay above the current take.
    await goto(page, fixture.states);
    const states = page.locator('article');
    await states.first().waitFor();
    const busy = await text(states.nth(0));
    check(/Generating/.test(busy) && /newer, not current/.test(busy) && /take \d+ generating/.test(busy), `${tag}: a take still generating is shown above the current take`);
    const failed = await text(states.nth(1));
    check(/Failed/.test(failed) && /did not answer in time/.test(failed), `${tag}: a failed newer take shows its error`);
    await tapTargets(page, `${tag} generation states`);
    await overflow(page, `${tag} generation states`);

    for (const name of [/^Pronunciation/, 'Voice profile']) {
      await page.getByRole('tab', { name }).click();
      await overflow(page, `${tag} ${typeof name === 'string' ? name : 'pronunciation'} tab`);
    }
    return { page, plans, created, run };
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-failure.png`, fullPage: true }).catch(() => null);
    return null;
  }
}

/** 1280 only: directions, several chunks at once, an A/B, the acceptance experiment (its run number is returned). */
async function desktop({ page, plans, created, run }) {
  const tag = '1280';
  try {
    await goto(page, run);

    // Directions by the card's sentence numbers: a sentence the chunk does not have is refused; the note is kept with the take.
    const card = page.locator('article').nth(0);
    const count = await card.locator('sup[data-sentence]').count();
    await card.getByRole('button', { name: 'Regenerate with directions' }).click();
    const box = card.getByLabel(/^One line per direction/);
    const direct = card.getByRole('button', { name: 'Regenerate with these directions' });
    await box.fill(`${count + 1}: curious`);
    check((await direct.isDisabled()) && new RegExp(`a sentence number from 1 to ${count}`).test(await text(card)), `${tag}: a direction for sentence ${count + 1} of ${count} is refused before anything is sent`);
    await box.fill('1: curious');
    await card.getByLabel(/^Note \(kept with the take/).fill('arm C');
    check(await direct.isEnabled(), `${tag}: a direction for sentence 1 can be sent`);
    await direct.click();
    const directed = card.locator('[data-current="true"]', { hasText: 'Note: arm C' });
    await until(async () => (await directed.count()) === 1 && /Directions: 1: curious \(director\)/.test(await text(directed)), 'the directed take current');
    check(true, `${tag}: regenerating with directions makes the directed take current, its direction and note shown`);

    await page.getByLabel('Select chunk 2').check();
    await page.getByLabel('Select chunk 3').check();
    const panel = section(page, 'Regenerate several chunks');
    const confirm = panel.getByRole('checkbox', { name: /I confirm/ });
    check(/I confirm 2 new takes of 2 chunks: about [\d,]+ characters, MOCK voice: no cost/.test(await text(panel)), `${tag}: regenerating selected chunks states takes, characters and cost`);
    const go = panel.getByRole('button', { name: 'Regenerate selected (2)' });
    check(await go.isDisabled(), `${tag}: regenerating selected chunks waits for the confirmation`);
    await confirm.check();
    await go.click();
    const cards = page.locator('article');
    await until(async () => (await Promise.all([1, 2].map(async (i) => (await cards.nth(i).locator('[data-take="2"][data-current="true"]').count()) === 1))).every(Boolean), 'chunks 2 and 3 regenerated');
    check(true, `${tag}: one job regenerated the two selected chunks`);
    await panel.getByLabel('Which chunks').selectOption('all');
    check(/I confirm \d+ new takes of \d+ chunks: about [\d,]+ characters/.test(await text(panel)) && (await panel.getByRole('button', { name: /^Regenerate every chunk \(\d+\)$/ }).isDisabled()), `${tag}: every chunk is behind a confirmation with characters and cost`);
    await panel.getByLabel('Which chunks').selectOption('section');
    check((await panel.getByRole('button', { name: /^Regenerate section SC\d\d$/ }).count()) === 1, `${tag}: a section can be regenerated`);
    await panel.getByLabel('Which chunks').selectOption('selected');

    // A/B of chunk 3: two takes beside the current one; pick B.
    await page.getByLabel('Select chunk 3').check();
    await panel.getByLabel('As an A/B comparison').check();
    check(/I confirm 2 new takes of 1 chunk/.test(await text(panel)), `${tag}: an A/B states its two takes`);
    await panel.getByRole('checkbox', { name: /I confirm/ }).check();
    await panel.getByRole('button', { name: 'Generate the A/B takes (1 chunk)' }).click();
    const third = cards.nth(2);
    const takeB = third.locator('[data-take]', { hasText: 'A/B · B expressive' });
    await until(async () => (await takeB.count()) === 1 && /Generated/.test(await text(takeB)) && /Generated/.test(await text(third.locator('[data-take]', { hasText: 'A/B · A restrained' }))), 'A/B takes generated');
    check(/newer, not current/.test(await text(takeB)) && (await third.locator('[data-take="2"][data-current="true"]').count()) === 1, `${tag}: A/B takes wait beside the current take, not made current`);
    await takeB.getByRole('button', { name: 'Use this take' }).click();
    await until(async () => (await third.locator('[data-current="true"]', { hasText: 'A/B · B expressive' }).count()) === 1, 'take B current');
    check(true, `${tag}: "Use this take" picks B`);
    await tapTargets(page, `${tag} after A/B`);
    await overflow(page, `${tag} A/B`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-ab.png`, fullPage: true });

    // The acceptance experiment: planned, one confirmation, one job, seven runs to hear whole.
    await page.getByRole('tab', { name: 'Audition & generate' }).click();
    const preset = section(page, /^Acceptance experiment — /);
    await preset.getByRole('button', { name: 'Plan the acceptance experiment (nothing is generated)' }).click();
    await until(async () => (await preset.locator('[data-variant]').count()) === 7, 'seven planned variants', 60_000);
    const planned = await text(preset);
    check(['A plain', 'B restrained', 'C expressive', 'D over-directed', 'E no context', 'F 5–8 s chunks', 'G 12–20 s chunks'].every((l) => planned.includes(l)), `${tag}: the acceptance plan lists variants A–G`);
    check(/13–20 words/.test(await text(preset.locator('[data-variant="F 5–8 s chunks"]'))) && /30–50 words/.test(await text(preset.locator('[data-variant="G 12–20 s chunks"]'))) && /none/.test(await text(preset.locator('[data-variant="E no context"]'))), `${tag}: F and G change the chunk size, E the context`);
    check(/7 runs in one job .*: \d+ takes, about [\d,]+ characters, MOCK voice: no cost/.test(planned), `${tag}: one total of characters and cost for the whole experiment`);
    const start = preset.getByRole('button', { name: 'Generate the acceptance experiment (7 runs, one job)' });
    check(await start.isDisabled(), `${tag}: the experiment waits for its one confirmation`);
    const planned7 = plans.slice(-7);
    check(planned7.slice(1).every((b) => b.profileId && b.profileId === planned7[1].profileId), `${tag}: the seven variants are planned on one profile`);
    await preset.getByRole('checkbox', { name: /I confirm all 7 runs/ }).check();
    await start.click();
    // The page is already on a run: wait for the experiment's first run.
    await page.waitForURL((u) => /^\d+$/.test(u.searchParams.get('run') ?? '') && u.searchParams.get('run') !== String(run));
    check(!!planned7[1].profileId && created.at(-1)?.profileId === planned7[1].profileId, `${tag}: the experiment is generated on the profile it was planned on`);
    const acceptance = Number(new URL(page.url()).searchParams.get('run'));
    const comparison = section(page, /^Comparison “Acceptance experiment” — 7 variants/);
    await comparison.waitFor({ timeout: 30_000 });
    await until(async () => (await comparison.locator('audio').count()) === 7 && !/not all generated/.test(await text(comparison)), 'seven assembled variants', 120_000);
    check(true, `${tag}: the experiment's seven runs are assembled side by side`);
    const g = await play(comparison.locator('[data-variant="G 12–20 s chunks"] audio'));
    check(g.duration > 0, `${tag}: variant G plays whole (${g.duration?.toFixed?.(1)} s)`);
    await overflow(page, `${tag} acceptance comparison`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-acceptance.png`, fullPage: true });
    return acceptance;
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-failure-desktop.png`, fullPage: true }).catch(() => null);
    return null;
  }
}

/** 412 and 360: the acceptance experiment planned (a variant's chunks open) and its seven runs side by side, without overflow. */
async function phone(width, acceptance) {
  const tag = String(width);
  const { page } = await open(width);
  try {
    await goto(page);
    await page.getByRole('tab', { name: 'Audition & generate' }).click();
    const preset = section(page, /^Acceptance experiment — /);
    await preset.getByRole('button', { name: 'Plan the acceptance experiment (nothing is generated)' }).click();
    await until(async () => (await preset.locator('[data-variant]').count()) === 7, 'seven planned variants', 60_000);
    await preset.locator('[data-variant="G 12–20 s chunks"] summary').click();
    check((await preset.locator('[data-variant="G 12–20 s chunks"] li[data-plan-chunk]').count()) >= 1, `${tag}: a planned variant opens its chunks`);
    check(await preset.getByRole('button', { name: /^Generate the acceptance experiment/ }).isDisabled(), `${tag}: the experiment waits for its confirmation`);
    await overflow(page, `${tag} acceptance plan`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-acceptance-plan.png`, fullPage: true });
    if (acceptance) {
      await goto(page, acceptance);
      const comparison = section(page, /^Comparison “Acceptance experiment” — 7 variants/);
      await until(async () => (await comparison.locator('audio').count()) === 7, 'seven assembled variants', 30_000);
      const small = await comparison.locator('button').evaluateAll((bs) => bs.filter((b) => b.getBoundingClientRect().height < 24).map((b) => b.textContent.trim()));
      check(!small.length, `${tag}: every button in the comparison is at least 24 px tall${small.length ? ` (${small.join(', ')})` : ''}`);
      await overflow(page, `${tag} acceptance comparison`);
      await page.screenshot({ path: `${OUT}/voice-${tag}-acceptance.png`, fullPage: true });
    }
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-failure-phone.png`, fullPage: true }).catch(() => null);
  }
}

/** Last (it changes the profile the other widths plan with): a new profile version is what "Profile default" uses. */
async function profile(width) {
  const tag = String(width);
  const { page, plans } = await open(width);
  try {
    await goto(page);
    await page.getByRole('tab', { name: 'Voice profile' }).click();
    const preset = page.getByRole('button', { name: '≈12–20 s' });
    await preset.click();
    check((await preset.getAttribute('aria-pressed')) === 'true', `${tag}: the chosen chunk size is pressed`);
    await page.getByRole('button', { name: 'Create the new version' }).click();
    await until(async () => /Chunks\s*30–50 words \(≈12–20 s\)/.test(await text(section(page, /^Active profile — /))), 'new profile version active');
    check(true, `${tag}: a new profile version sets the chunk size`);
    await page.getByRole('tab', { name: 'Audition & generate' }).click();
    check(/^Profile default \(30–50 words/.test(await page.getByLabel('Chunk size (natural boundaries come first)').locator('option').first().innerText()), `${tag}: "Profile default" is the new version's size`);
    plans.length = 0;
    await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
    await page.getByRole('heading', { name: /^Plan — / }).waitFor();
    check(!('chunking' in (plans.at(-1)?.options ?? {})) && /Chunk size\s*30–50 words/.test(await text(section(page, /^Plan — /))), `${tag}: planned with the profile's size, none sent`);
    await overflow(page, `${tag} profile`);

    // A version made behind the page's back (another tab) between plan and generate: the run is the one planned.
    await page.evaluate(async (slug) => {
      const r = await fetch(`/api/projects/${slug}/voice/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chunking: { minWords: 13, maxWords: 20 }, notes: 'UI check: made in another tab' }) });
      if (!r.ok) throw new Error(`profile: ${r.status} ${await r.text()}`);
    }, fixture.slug);
    await page.getByRole('button', { name: 'Generate the audition' }).click();
    await page.waitForURL(/[?&]run=\d+/);
    const made = section(page, /^Voice run \d+ — /);
    await made.waitFor();
    check(/Chunks\s*\d+ · 30–50 words/.test(await text(made)), `${tag}: a profile version made after the plan does not change the run (planned 30–50 words: ${(/Chunks\s*([^\n]+)/.exec(await text(made)) ?? [])[1]})`);
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/voice-${tag}-failure-profile.png`, fullPage: true }).catch(() => null);
  }
}

const wide = await core(1280);
const acceptance = wide ? await desktop(wide) : null;
await core(412);
await core(360);
await phone(412, acceptance);
await phone(360, acceptance);
await profile(1280);
await browser.close();
console.log(problems.length ? `console problems:\n${problems.join('\n')}` : 'no console errors or warnings');
console.log(failures.length ? `${failures.length} check(s) failed` : 'every check passed');
process.exit(failures.length || problems.length ? 1 : 0);
