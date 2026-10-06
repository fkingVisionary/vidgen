// Browser QA of the Voice page and the voice profile library at 360, 412 and
// 1280 px against the MOCK fixture (scripts/ui/voice-ui.sh starts it and runs
// this). It clicks: plan, generate an audition, play the assembled audio,
// regenerate one chunk (take 2 current, take 1 under earlier), approve, use
// the previous take, compare earlier takes and a comparison's variants; at
// 1280 also regenerate with directions, regenerate selected chunks, an A/B of
// one chunk and the acceptance experiment (planned again at 412 and 360).
// The library at every width: create a profile with the provider's settings
// form, edit it to v2 (the history says what changed), duplicate it, archive,
// unarchive and rename the copy; at 1280 an edit refused because another tab
// saved a version keeps its changes and is saved on purpose. At 1280, last (it
// changes the project's profile): a
// run made before saved profiles reads reconstructed; a comparison variant is
// saved as a profile and used for the project; a project override shows where
// it came from and leaves the profile alone; a new run keeps its
// configuration after the profile is edited; takes regenerated with the
// production profile and with a temporary override are labelled; a pinned
// version says a newer one exists; a comparison of saved profiles and the
// acceptance experiment with another profile are planned; and a plan is not
// moved by an edit in another tab, while an override changed in another tab
// asks to plan again. On every width: no horizontal overflow, every button at
// least 24 px tall, generation state visible, no console errors.
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
/** 409 answers a check provokes on purpose (a plan made stale in another tab): the browser logs each as a failed resource, which is expected only then. */
let expectedConflicts = 0;
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
/** A heading's own words (section headings are upper-cased by CSS, which innerText applies). */
const words = async (l) => (await l.textContent()) ?? '';
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
/** Every visible button and folding summary in a part of the page is at least 24 px tall. */
const tapTargetsIn = async (page, selector, where) => {
  const small = await page.evaluate((sel) =>
    [...document.querySelectorAll(`${sel} button, ${sel} summary`)]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ t: b.textContent.trim().slice(0, 40), h: Math.round(b.getBoundingClientRect().height) }))
      .filter((b) => b.h < 24),
  selector);
  check(!small.length, `${where}: every button is at least 24 px tall${small.length ? ` (${small.map((b) => `"${b.t}" ${b.h}px`).join(', ')})` : ''}`);
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
    if (m.type() === 'error' && expectedConflicts > 0 && /status of 409 \(Conflict\)/.test(m.text())) {
      expectedConflicts--;
      return;
    }
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
  check(/^Production profile \(\d+–\d+ words \(≈\d+–\d+ s\)\)$/.test(sizes[0]) && ['≈5–8 s', '≈8–12 s', '≈12–20 s'].every((s) => sizes.some((o) => o.startsWith(s))), `${tag}: chunk sizes are the production profile's and ≈5–8 / 8–12 / 12–20 s (${sizes.join(' | ')})`);
  const compareOptions = await page.getByLabel('Generate as').locator('option').allInnerTexts();
  check(compareOptions.some((o) => /plain \/ restrained \/ expressive/.test(o)) && compareOptions.some((o) => /no context \/ neighbouring text/.test(o)) && compareOptions.some((o) => /≈5–8 \/ ≈8–12 \/ ≈12–20 s/.test(o)) && compareOptions.some((o) => /saved profiles/.test(o)), `${tag}: direction, continuity, chunk-size and saved-profile comparisons offered`);
  await page.getByLabel('About how long (seconds, whole blocks)').fill('60');

  // A plan, then a comparison planned and confirmed — then the scope changes: plan and confirmation are gone.
  plans.length = 0;
  await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
  await page.getByRole('heading', { name: /^Plan — / }).waitFor();
  const sent = plans.at(-1)?.options ?? {};
  check(!('chunking' in sent) && !('strategy' in sent) && !('context' in sent), `${tag}: "Production profile" sends no chunking, strategy or context (${JSON.stringify(sent)})`);
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

    for (const name of [/^Pronunciation/, 'Production profile']) {
      await page.getByRole('tab', { name }).click();
      await overflow(page, `${tag} ${typeof name === 'string' ? name : 'pronunciation'} tab`);
      await tapTargetsIn(page, 'main', `${tag} ${typeof name === 'string' ? name : 'pronunciation'} tab`);
    }
    await page.screenshot({ path: `${OUT}/voice-${tag}-production.png`, fullPage: true });
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
    await card.getByRole('button', { name: 'Regenerate with…' }).click();
    check(await card.getByLabel("This run's configuration", { exact: true }).isChecked(), `${tag}: "Regenerate with…" starts from the run's configuration`);
    const box = card.getByLabel(/^Directions \(optional\), one line per direction/);
    const direct = card.getByRole('button', { name: 'Generate the new take' });
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
    const queued = created.at(-1) ?? {};
    check(!!planned7[1].profileId && queued.variants?.length === 7 && queued.variants.every((x) => x.profileId === planned7[1].profileId) && Number.isInteger(queued.selectionRevision), `${tag}: the experiment is generated on the profile and at the revision it was planned at`);
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

const profilesUrl = (path = '') => `${BASE}/voice-profiles${path}`;
/** The API as the page calls it (same origin): what another tab would do. */
const apiOf = (page) => (method, path, body) =>
  page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(p, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${data?.message ?? ''}`);
      return data;
    },
    [method, path, body],
  );
/** The value of the option whose text starts with `label`. */
const optionValue = (select, label) => select.locator('option').evaluateAll((os, l) => os.find((o) => o.textContent.trim().startsWith(l))?.value ?? null, label);

/** The library at one width: the house default listed; a profile created with the provider's settings form, edited to v2, duplicated, and the copy archived and unarchived. */
async function profiles(width) {
  const tag = `${width} library`;
  const { page } = await open(width);
  const name = `UI profile ${width}`;
  try {
    await page.goto(profilesUrl());
    await page.getByRole('heading', { name: 'Voice profiles', exact: true }).waitFor();
    check(await page.locator('header').getByRole('link', { name: 'Voice profiles' }).isVisible(), `${tag}: the header links the voice profiles`);
    const house = page.locator('article[data-profile="House narrator"]');
    await house.waitFor();
    check(/library default/.test(await text(house)) && /current v1/.test(await text(house)), `${tag}: House narrator is listed as the library default, v1`);
    check(await house.getByRole('button', { name: 'Archive', exact: true }).isDisabled(), `${tag}: the library default cannot be archived`);
    await overflow(page, `${tag} list`);
    await tapTargetsIn(page, 'main', `${tag} list`);
    await page.screenshot({ path: `${OUT}/profiles-${width}-list.png`, fullPage: true });

    // A new profile from the provider's descriptions: the stability slider moves its field, speed typed, a rule added.
    await page.getByRole('button', { name: 'New profile' }).click();
    const form = page.locator('form[data-profile-form="new"]');
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Performance').selectOption('EXPRESSIVE');
    const slider = form.getByLabel('Stability (slider)');
    await slider.focus();
    for (let i = 0; i < 3; i++) await slider.press('ArrowLeft');
    check((await form.getByLabel('Stability', { exact: true }).inputValue()) === '0.35', `${tag}: the stability slider sets its number field (0.35)`);
    await form.getByLabel('Speed', { exact: true }).fill('1.05');
    check(/base speaking rate/.test(await text(form.locator('[data-setting="speed"]'))) && (await form.locator('[data-setting]').count()) === 5, `${tag}: the provider's five settings with their help`);
    await form.getByRole('button', { name: 'Add a rule' }).click();
    await form.getByLabel('Term 1', { exact: true }).fill('Haarlem');
    await form.getByLabel('Pronunciation 1', { exact: true }).fill('Harlem');
    check(/The project's approved pronunciations always apply/.test(await text(form)), `${tag}: the form says the project's approved pronunciations always apply`);
    await overflow(page, `${tag} new profile form`);
    await tapTargetsIn(page, 'form', `${tag} new profile form`);
    await page.screenshot({ path: `${OUT}/profiles-${width}-new.png`, fullPage: true });
    await form.getByRole('button', { name: 'Create the profile' }).click();
    await page.waitForURL(/\/voice-profiles\/[0-9a-f-]{36}$/);
    const familyUrl = page.url();
    const card = page.locator(`article[data-profile="${name}"]`);
    await card.waitFor();
    const v1 = page.locator('li[data-version="1"]');
    await v1.locator('summary').click();
    const v1Text = await text(v1);
    check(/current v1/.test(await text(card)) && /made in the library/.test(v1Text) && /Stability\s*0\.35/.test(v1Text) && /Speed\s*1\.05/.test(v1Text) && /Haarlem → Harlem \(alias\)/.test(v1Text) && /Expressive moments/.test(v1Text), `${tag}: v1 is saved with what the form set`);

    // Edit: always a new version; the history says what changed.
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.locator('form[data-profile-form="edit"]');
    check(/Saves v2\. 0 projects follow this profile: their next runs use the new version; runs already made keep theirs\./.test(await text(edit.locator('[data-edit-note]'))), `${tag}: the edit says it saves v2 and who follows`);
    await edit.getByLabel('Performance').selectOption('RESTRAINED');
    await edit.getByRole('button', { name: 'Save v2' }).click();
    const v2 = page.locator('li[data-version="2"]');
    await until(async () => (await v2.count()) === 1, 'v2 in the history');
    check(/current/.test(await text(v2)) && /an edit of v1/.test(await text(v2)) && /performance: expressive → restrained/.test(await text(v2)), `${tag}: v2 is current and its history says "performance: expressive → restrained"`);
    check(/current v2/.test(await text(card)), `${tag}: the card's current version is v2`);
    await overflow(page, `${tag} history`);
    await tapTargetsIn(page, 'main', `${tag} history`);
    await page.screenshot({ path: `${OUT}/profiles-${width}-history.png`, fullPage: true });

    // Duplicate (of v2), then archive the copy: hidden from the list, shown with "Show archived", unarchived.
    await card.getByRole('button', { name: 'Duplicate' }).click();
    const dup = page.locator('form[data-profile-form="duplicate"]');
    check((await dup.getByLabel('Name', { exact: true }).inputValue()) === `${name} copy`, `${tag}: a duplicate is offered a name of its own`);
    await dup.getByRole('button', { name: 'Create the copy' }).click();
    await page.waitForURL((u) => /\/voice-profiles\/[0-9a-f-]{36}$/.test(u.pathname) && u.href !== familyUrl);
    const copy = page.locator(`article[data-profile="${name} copy"]`);
    await copy.waitFor();
    check(/a duplicate of UI profile \d+ v2/.test(await text(page.locator('li[data-version="1"]'))), `${tag}: the copy's v1 says what it was copied from`);
    await copy.getByRole('button', { name: 'Archive', exact: true }).click();
    await until(async () => /\barchived\b/.test(await text(copy.locator('header'))), 'the copy archived');
    await page.goto(profilesUrl());
    await house.waitFor();
    check((await page.locator(`article[data-profile="${name} copy"]`).count()) === 0 && (await page.locator(`article[data-profile="${name}"]`).count()) === 1, `${tag}: an archived profile is not listed`);
    await page.getByLabel('Show archived').check();
    const shown = page.locator(`article[data-profile="${name} copy"]`);
    await shown.waitFor();
    check(/\barchived\b/.test(await text(shown.locator('header'))), `${tag}: "Show archived" lists it, marked archived`);
    await shown.getByRole('button', { name: 'Unarchive' }).click();
    await until(async () => !/\barchived\b/.test(await text(shown.locator('header'))), 'the copy unarchived');
    check(true, `${tag}: unarchived`);
    await overflow(page, `${tag} list with archived`);
    await tapTargetsIn(page, 'main', `${tag} list with archived`);

    // Rename the copy: the profile's name changes; its version keeps the name it was made with.
    await shown.getByRole('button', { name: 'Rename' }).click();
    const rename = shown.locator('form[data-rename]');
    await rename.getByLabel('Name', { exact: true }).fill(`${name} kept`);
    await overflow(page, `${tag} rename`);
    await tapTargetsIn(page, 'form[data-rename]', `${tag} rename`);
    await rename.getByRole('button', { name: 'Save the name' }).click();
    const renamed = page.locator(`article[data-profile="${name} kept"]`);
    await renamed.waitFor();
    await renamed.getByRole('link', { name: `${name} kept` }).click();
    await until(async () => /made as UI profile \d+ copy\b/.test(await text(page.locator('li[data-version="1"]'))), 'the renamed profile\'s history');
    check(true, `${tag}: a renamed profile keeps its version's name ("made as ${name} copy")`);

    // 1280: an edit opened before another tab saved a version is refused (409), keeps its changes, then is saved on purpose.
    if (width === 1280) {
      await page.goto(familyUrl);
      await card.waitFor();
      await card.getByRole('button', { name: 'Edit', exact: true }).click();
      const stale = page.locator('form[data-profile-form="edit"]');
      await stale.getByLabel('Performance').selectOption('PLAIN');
      await apiOf(page)('POST', `/api/voice/profiles/${familyUrl.split('/').at(-1)}/versions`, { fields: { numberStyle: 'US' }, notes: 'UI check: made in another tab' });
      expectedConflicts++;
      const refused = page.waitForResponse((r) => r.request().method() === 'POST' && /\/versions$/.test(r.url()));
      await stale.getByRole('button', { name: 'Save v3' }).click();
      check((await refused).status() === 409, `${tag}: an edit opened before another tab saved v3 is answered 409`);
      const since = stale.locator('[data-edit-since]');
      await until(async () => /v3 was saved since this form opened/.test(await text(since)), 'the version saved since named');
      check((await stale.getByLabel('Performance').inputValue()) === 'PLAIN' && (await stale.getByRole('button', { name: 'Save v4', exact: true }).isDisabled()), `${tag}: the refused edit keeps its changes and names v3, saved since`);
      await since.getByRole('button', { name: 'Save v4 anyway' }).click();
      const v4 = page.locator('li[data-version="4"]');
      await until(async () => (await v4.count()) === 1, 'v4 in the history');
      check(/current/.test(await text(v4)) && /an edit of v2/.test(await text(v4)) && /performance: restrained → plain/.test(await text(v4)) && /current v4/.test(await text(card)), `${tag}: saved on purpose, v4 (an edit of v2) is current`);
    }
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/profiles-${width}-failure.png`, fullPage: true }).catch(() => null);
  }
}

/** Plan and generate an audition with what the Generate tab is set to; returns the new run's number. */
async function audition(page, plans) {
  await page.getByRole('tab', { name: 'Audition & generate' }).click();
  await page.getByLabel('About how long (seconds, whole blocks)').fill('40');
  plans.length = 0;
  await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
  await page.getByRole('heading', { name: /^Plan — Opening audition/ }).waitFor();
  const before = page.url();
  await page.getByRole('button', { name: 'Generate the audition' }).click();
  await page.waitForURL((u) => u.href !== before && /^\d+$/.test(u.searchParams.get('run') ?? ''));
  return Number(new URL(page.url()).searchParams.get('run'));
}

/** The project's production profile, at 1280, last: it changes what the project narrates with. */
async function production() {
  const tag = '1280 production';
  const { page, plans, created } = await open(1280);
  const name = 'UI Tulip narrator';
  const api = apiOf(page);
  try {
    // A run made before saved profiles: House narrator v1, reconstructed; its cost reads as the characters sent.
    const [legacy] = fixture.comparison;
    await goto(page, legacy);
    const old = section(page, new RegExp(`^Voice run ${legacy} — `));
    const voice = old.locator('[data-run-profile]');
    check(/House narrator v1/.test(await text(voice)) && /reconstructed/.test(await text(voice)), `${tag}: the run made before saved profiles reads "House narrator v1 · reconstructed" (${await text(voice)})`);
    await old.locator('[data-run-configuration] summary').click();
    check(/Reconstructed: made before saved profiles/.test(await text(old)) && (await old.locator('[data-config-row]').count()) > 10, `${tag}: its configuration is shown, reconstructed`);
    check(/^sent [\d,]+ characters · provider reported none$/.test((await text(old.locator('[data-run-cost]'))).trim()), `${tag}: a run's cost reads "sent N characters · provider reported …"`);
    await page.screenshot({ path: `${OUT}/production-reconstructed.png`, fullPage: true });

    // Save variant C's configuration from its card, then use it for this project: production follows it.
    const comparison = section(page, /^Comparison “Performance direction” — 3 variants/);
    const cardC = comparison.locator('[data-variant="C expressive"]');
    await until(async () => /Profile\s*House narrator v1/.test(await text(cardC)), 'variant C loaded');
    check(/^sent [\d,]+ characters · provider reported none$/.test((await text(cardC.locator('[data-variant-cost]'))).trim()), `${tag}: a variant's cost reads "sent N characters · provider reported …"`);
    await cardC.getByRole('button', { name: "Save this run's configuration as a voice profile" }).click();
    check((await cardC.getByLabel('Profile name').inputValue()) === 'UI check — voice narrator', `${tag}: the name offered is "{project title} narrator"`);
    await cardC.getByLabel('Profile name').fill(name);
    await cardC.getByRole('button', { name: 'Save profile' }).click();
    await until(async () => /Saved UI Tulip narrator v1/.test(await text(cardC)), 'saved from the variant card');
    check(true, `${tag}: "Save this run's configuration as a voice profile" saved UI Tulip narrator v1 from variant C`);
    const familyPath = await cardC.getByRole('link', { name: 'Open in the library' }).getAttribute('href');
    const familyId = familyPath.split('/').at(-1);
    await cardC.getByRole('button', { name: 'Use for this project' }).click();
    await until(async () => /In use for this project/.test(await text(cardC)), 'in use for the project');
    check(true, `${tag}: "Use for this project" makes it the project's profile`);
    await page.getByRole('tab', { name: 'Production profile' }).click();
    const prod = section(page, /^Production profile — /);
    await prod.waitFor();
    check(/UI Tulip narrator v1/.test(await words(prod.getByRole('heading'))) && /follows the current version/.test(await text(prod)), `${tag}: the Production profile tab shows it, following`);
    check(/Expressive moments/.test(await text(prod.locator('[data-config-row="strategy"]'))) && /profile/.test(await text(prod.locator('[data-config-row="strategy"]'))), `${tag}: production's performance is the saved variant's (expressive), from the profile`);

    // A project override of stability 0.4: production shows it from the project; the saved profile keeps 0.5.
    const choose = section(page, 'Choose the production profile');
    check(/Overrides apply to this project's new runs only; the saved profile is unchanged\./.test(await text(choose)), `${tag}: overrides are said to apply to this project only`);
    await choose.getByLabel('Override for this project: Stability').check();
    await choose.locator('[data-override="providerSettings.stability"]').getByLabel('Stability', { exact: true }).fill('0.4');
    await choose.getByRole('button', { name: 'Save the production profile' }).click();
    const stability = prod.locator('[data-config-row="providerSettings.stability"]');
    await until(async () => /0\.4/.test(await text(stability)) && /project/.test(await text(stability)), 'stability 0.4 from the project');
    check(true, `${tag}: production shows stability 0.4 with the project chip`);
    await overflow(page, `${tag} production tab`);
    await tapTargetsIn(page, 'main', `${tag} production tab`);
    await page.screenshot({ path: `${OUT}/production-override.png`, fullPage: true });
    const library = await page.context().newPage();
    await library.goto(profilesUrl(`/${familyId}`));
    const libV1 = library.locator('li[data-version="1"]');
    await libV1.waitFor();
    await libV1.locator('summary').click();
    const libStability = libV1.locator('[data-config-row="providerSettings.stability"]');
    check(/0\.5/.test(await text(libStability)) && /profile/.test(await text(libStability)), `${tag}: the library still shows the profile's stability (0.5)`);
    check(/saved from voice run \d+ of [a-z0-9-]+ \(Performance direction — C expressive\)/.test(await text(libV1)), `${tag}: the version says which run and variant it was saved from`);

    // A new run: its configuration shows the project's override, from the project.
    const run = await audition(page, plans);
    await generated(page, run);
    const made = section(page, new RegExp(`^Voice run ${run} — `));
    check(/UI Tulip narrator v1/.test(await text(made.locator('[data-run-profile]'))) && !/reconstructed/.test(await text(made.locator('[data-run-profile]'))), `${tag}: the new run is made with UI Tulip narrator v1`);
    await made.locator('[data-run-configuration] summary').click();
    const runStability = made.locator('[data-config-row="providerSettings.stability"]');
    check(/0\.4/.test(await text(runStability)) && /project/.test(await text(runStability)), `${tag}: the new run's configuration shows stability 0.4 with the project chip`);
    const snapshot = await text(made.locator('[data-config]'));

    // Edit the profile in the library (another tab): v2; the run keeps its configuration; production follows v2.
    await library.reload();
    const libCard = library.locator(`article[data-profile="${name}"]`);
    await libCard.waitFor();
    check(/Used by:\s*UI check — voice \(en, follows\)/.test(await text(libCard)), `${tag}: the library says the project follows the profile`);
    await libCard.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = library.locator('form[data-profile-form="edit"]');
    check(/Saves v2\. 1 project follows this profile/.test(await text(edit.locator('[data-edit-note]'))), `${tag}: the edit says one project follows the profile`);
    await edit.getByLabel('Performance').selectOption('RESTRAINED');
    await edit.getByRole('button', { name: 'Save v2' }).click();
    await until(async () => /performance: expressive → restrained/.test(await text(library.locator('li[data-version="2"]'))), 'v2 saved in the library');
    check(true, `${tag}: the profile is edited to v2 in the library`);
    await goto(page, run);
    const again = section(page, new RegExp(`^Voice run ${run} — `));
    await again.locator('[data-run-configuration] summary').click();
    check((await text(again.locator('[data-config]'))) === snapshot && /UI Tulip narrator v1/.test(await text(again.locator('[data-run-profile]'))), `${tag}: the earlier run's configuration is unchanged by the edit`);
    await page.getByRole('tab', { name: 'Production profile' }).click();
    await until(async () => /UI Tulip narrator v2/.test(await words(section(page, /^Production profile — /).getByRole('heading'))), 'production on v2');
    check(true, `${tag}: the production profile follows v2`);

    // Regenerate chunk 1 with the production profile now, chunk 2 with a temporary override: each take labelled.
    await page.getByRole('tab', { name: new RegExp(`^Voice run ${run}$`) }).click();
    const first = page.locator('article[data-chunk="1"]');
    await first.getByRole('button', { name: 'Regenerate with…' }).click();
    await first.getByLabel(/^The production profile now: UI Tulip narrator v2/).check();
    check(/differs from the run: performance: restrained \(run: expressive\)/.test(await text(first.locator('[data-take-choice]'))), `${tag}: the production choice says how it differs from the run`);
    await first.getByRole('button', { name: 'Generate the new take' }).click();
    const prodTake = first.locator('[data-take="2"][data-current="true"] [data-take-config="production"]');
    await until(async () => (await prodTake.count()) === 1 && /production profile · UI Tulip narrator v2/.test(await text(prodTake)), 'the production take current');
    check(/differs from the run: performance: restrained \(run: expressive\)/.test(await text(first.locator('[data-take="2"]'))), `${tag}: a take regenerated with the production profile is labelled "production profile · UI Tulip narrator v2" and says how it differs`);
    const second = page.locator('article[data-chunk="2"]');
    await second.getByRole('button', { name: 'Regenerate with…' }).click();
    await second.getByLabel('A temporary override').check();
    check(/The override is kept with the new take only; the profile is not changed\./.test(await text(second)), `${tag}: the override is said to be the take's only`);
    await second.getByLabel('Override for this take: Performance').check();
    await second.locator('[data-override="strategy"]').getByRole('combobox').selectOption('PLAIN');
    await second.getByRole('button', { name: 'Generate the new take' }).click();
    const overTake = second.locator('[data-take="2"][data-current="true"]');
    await until(async () => (await overTake.locator('[data-take-config="override"]').count()) === 1, 'the overridden take current');
    check(/temporary override · performance plain/.test(await text(overTake.locator('[data-take-config="override"]'))) && (await overTake.getByRole('button', { name: "Save this take's configuration as a voice profile" }).count()) === 1, `${tag}: a take with a temporary override is labelled "temporary override · performance plain" and can be saved as a profile`);
    const history = await api('GET', `/api/voice/profiles/${familyId}`);
    check(history.history.length === 2 && history.current.config.strategy === 'RESTRAINED', `${tag}: no regeneration changed the profile (still v2, restrained)`);
    await tapTargets(page, `${tag} labelled takes`);
    await tapTargetsIn(page, 'main', `${tag} run tab`);
    await overflow(page, `${tag} labelled takes`);
    await page.screenshot({ path: `${OUT}/production-takes.png`, fullPage: true });

    // Pin v1: "pinned to v1 (v2 available)"; then follow again.
    await page.getByRole('tab', { name: 'Production profile' }).click();
    let choice = section(page, 'Choose the production profile');
    await choice.getByLabel('Pin a version').check();
    const pinned = choice.getByLabel('Pinned version');
    await until(async () => (await optionValue(pinned, 'v1')) !== null, 'the versions to pin');
    await pinned.selectOption(await optionValue(pinned, 'v1'));
    await choice.getByRole('button', { name: 'Save the production profile' }).click();
    await until(async () => /pinned to v1 \(v2 available\)/.test(await text(section(page, /^Production profile — /))), 'pinned to v1');
    check(true, `${tag}: pinning v1 reads "pinned to v1 (v2 available)"`);
    await page.getByRole('tab', { name: 'Audition & generate' }).click();
    const offered = await page.getByLabel('Profile', { exact: true }).locator('option').allInnerTexts();
    check(!offered.some((o) => /^UI Tulip narrator v2/.test(o)) && /UI Tulip narrator v2 is its current version: follow it on the Production profile tab/.test(await text(page.locator('[data-heard-as]'))), `${tag}: pinned, the newer version is not offered as another profile, heard as saved (${offered.join(' | ')})`);
    await page.getByRole('tab', { name: 'Production profile' }).click();
    choice = section(page, 'Choose the production profile');
    await choice.getByLabel('Follow the current version').check();
    await choice.getByRole('button', { name: 'Save the production profile' }).click();
    await until(async () => /follows the current version/.test(await text(section(page, /^Production profile — /))), 'following again');

    // A comparison of two saved profiles is planned: one variant each.
    await page.getByRole('tab', { name: 'Audition & generate' }).click();
    await page.getByLabel('About how long (seconds, whole blocks)').fill('40');
    await page.getByLabel('Generate as').selectOption('profiles');
    const pick = page.locator('[data-compare-profiles]');
    await pick.getByLabel('Production profile (UI Tulip narrator v2)').check();
    await pick.getByLabel('House narrator v1', { exact: true }).check();
    plans.length = 0;
    await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
    const compared = section(page, /^Plan — Saved profiles, 2 variants/);
    await compared.waitFor();
    const variants = compared.locator('[data-variant]');
    check((await variants.count()) === 2 && /UI Tulip narrator v2/.test(await text(variants.nth(0))) && /House narrator v1 \(as saved\)/.test(await text(variants.nth(1))), `${tag}: a comparison of two saved profiles is planned, one variant each`);
    check(plans.length === 2 && !plans[0].profileId && !!plans[1].profileId && !('selectionRevision' in plans[0]) && Number.isInteger(plans[1].selectionRevision), `${tag}: the production variant is planned as production, the other on its own version, at the first plan's revision`);

    // The acceptance experiment with another saved profile chosen: all seven plans name it.
    await page.getByLabel('Generate as').selectOption('none');
    const profile = page.getByLabel('Profile', { exact: true });
    await profile.selectOption(await optionValue(profile, 'House narrator v1'));
    check(/Heard as saved: this project's overrides apply to its production profile only\./.test(await text(page.locator('[data-heard-as]'))), `${tag}: another profile is heard as saved`);
    const preset = section(page, /^Acceptance experiment — /);
    check(/House narrator v1/.test(await words(preset.getByRole('heading'))), `${tag}: the acceptance experiment names the chosen profile`);
    plans.length = 0;
    await preset.getByRole('button', { name: 'Plan the acceptance experiment (nothing is generated)' }).click();
    await until(async () => (await preset.locator('[data-variant]').count()) === 7, 'seven planned variants', 60_000);
    const named = await preset.locator('[data-variant]').allInnerTexts();
    check(named.length === 7 && named.every((t) => /Voice\s*House narrator v1 \(as saved\)/.test(t)), `${tag}: all seven acceptance plans narrate with House narrator v1`);
    check(plans.length === 7 && plans.every((b) => b.profileId && b.profileId === plans[0].profileId), `${tag}: the seven plans name the chosen profile's version`);
    await overflow(page, `${tag} generate tab`);
    await tapTargetsIn(page, 'main', `${tag} generate tab`);
    await page.screenshot({ path: `${OUT}/production-generate.png`, fullPage: true });

    // Another tab, after planning: an edit of the profile does not move the plan (the run is the version planned) …
    await profile.selectOption('');
    await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
    await page.getByRole('heading', { name: /^Plan — Opening audition/ }).waitFor();
    check(/UI Tulip narrator v2/.test(await text(section(page, /^Plan — Opening audition/))), `${tag}: planned on UI Tulip narrator v2`);
    await api('POST', `/api/voice/profiles/${familyId}/versions`, { fields: { strategy: 'PLAIN' }, notes: 'UI check: made in another tab' });
    const before = page.url();
    await page.getByRole('button', { name: 'Generate the audition' }).click();
    await page.waitForURL((u) => u.href !== before && /^\d+$/.test(u.searchParams.get('run') ?? ''));
    const pinnedRun = Number(new URL(page.url()).searchParams.get('run'));
    const madeAfter = section(page, new RegExp(`^Voice run ${pinnedRun} — `));
    await madeAfter.waitFor();
    check(/UI Tulip narrator v2/.test(await text(madeAfter.locator('[data-run-profile]'))), `${tag}: a version made in another tab after the plan does not change the run (v2 planned, v3 made since)`);
    await generated(page, pinnedRun);

    // … but an override changed in another tab is refused: plan again.
    await page.getByRole('tab', { name: 'Audition & generate' }).click();
    await page.getByLabel('About how long (seconds, whole blocks)').fill('41');
    await page.getByRole('button', { name: 'Plan (nothing is generated)' }).click();
    await page.getByRole('heading', { name: /^Plan — Opening audition/ }).waitFor();
    const now = await api('GET', `/api/projects/${fixture.slug}/voice/selection`);
    await api('PUT', `/api/projects/${fixture.slug}/voice/selection`, { familyId, versionId: null, overrides: { providerSettings: { stability: 0.45 } }, revision: now.revision });
    expectedConflicts++;
    const stale = page.waitForResponse((r) => r.request().method() === 'POST' && /\/voice\/runs$/.test(r.url()));
    await page.getByRole('button', { name: 'Generate the audition' }).click();
    check((await stale).status() === 409, `${tag}: generating a plan made at an old revision is answered 409`);
    const refused = page.locator('section', { has: page.getByRole('heading', { name: 'Generate', exact: true }) });
    await until(async () => /changed since this was planned \(revision \d+, now \d+\): plan again/.test(await text(refused)), 'the refusal: plan again');
    check(true, `${tag}: an override changed in another tab after the plan is refused: "plan again"`);

    // The production tab saved at an old revision: changed in another tab, reload.
    await page.getByRole('tab', { name: 'Production profile' }).click();
    choice = section(page, 'Choose the production profile');
    const latest = await api('GET', `/api/projects/${fixture.slug}/voice/selection`);
    await api('PUT', `/api/projects/${fixture.slug}/voice/selection`, { familyId, versionId: null, overrides: { providerSettings: { stability: 0.5 } }, revision: latest.revision });
    await choice.getByLabel('Override for this project: Number style').check();
    expectedConflicts++;
    const refusedSave = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/voice\/selection$/.test(r.url()));
    await choice.getByRole('button', { name: 'Save the production profile' }).click();
    check((await refusedSave).status() === 409, `${tag}: a choice saved at an old revision is answered 409`);
    await until(async () => /changed in another tab \(revision \d+, now \d+\): reload/.test(await text(choice)), 'the selection refused at an old revision');
    check((await choice.getByRole('button', { name: 'Reload' }).count()) === 1, `${tag}: saving at an old revision says it changed in another tab, with Reload`);
    // A read of the view in the meantime must not drop the refusal or what the editor set.
    await page.waitForTimeout(1500);
    check(/changed in another tab/.test(await text(choice)) && (await choice.getByLabel('Override for this project: Number style').isChecked()), `${tag}: the refusal and the edit stay until Reload`);
    await choice.getByRole('button', { name: 'Reload' }).click();
    await until(async () => /0\.5/.test(await text(section(page, /^Production profile — /).locator('[data-config-row="providerSettings.stability"]'))), 'reloaded');
    check(!(await section(page, 'Choose the production profile').getByLabel('Override for this project: Number style').isChecked()), `${tag}: Reload shows the choice made in the other tab, the form read again`);
    await library.close();
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/production-failure.png`, fullPage: true }).catch(() => null);
  }
}

const wide = await core(1280);
const acceptance = wide ? await desktop(wide) : null;
await core(412);
await core(360);
await phone(412, acceptance);
await phone(360, acceptance);
for (const width of [1280, 412, 360]) await profiles(width);
await production();
await browser.close();
check(expectedConflicts === 0, `every conflict provoked on purpose was answered (${expectedConflicts} outstanding)`);
console.log(problems.length ? `console problems:\n${problems.join('\n')}` : 'no console errors or warnings');
console.log(failures.length ? `${failures.length} check(s) failed` : 'every check passed');
process.exit(failures.length || problems.length ? 1 : 0);
