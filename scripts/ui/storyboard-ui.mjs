// Browser QA of the Storyboard page and the visual profile library at 1280,
// 412 and 360 px against the MOCK fixture (scripts/ui/storyboard-ui.sh starts
// it and runs this). At every width, on v1 as planned: every tab — Overview,
// Timeline (its lanes scroll inside their own box; a phone reads a list in
// time order), Shots (the "why is this visual here?" chain), Costs, Evidence,
// Continuity and QA — with no horizontal overflow, every button at least
// 24 px tall and no console errors. At 1280: shot decisions, the version
// approved, an edit saving v2 with v1 intact and still approved, decisions
// carried, an edit refused because another tab saved a version keeping its
// form and then saved on purpose, split, merge, move a cut, reorder, request
// changes, restore, another approach planned, the project's visual profile
// changed (and a change made in another tab refused until Reload) and a
// version re-costed with it, a continuity subject's design detail edited
// with its basis, a cheaper alternative applied, and on a second
// project a preview planned with its confirmation, whose approval waits for
// the takes; a confirmation given on one version never carries to another;
// the project page's storyboard card, pill and next step, and an old
// visual generation job whose retry is held there and refused. On the
// phones, an edit from the Shots tab, with a specific detail and its basis. The library at every width: the five
// presets, a profile created, edited to v2 (the history says what changed),
// duplicated, renamed, archived and unarchived; at 1280 an edit refused
// because another tab saved a version keeps its changes and is saved on
// purpose. Nothing is generated: the fixture's model is scripted and every
// provider is a mock.
//
// The guided flow, at 412 and 1280 px, on a project left as Tulip Mania was
// (seven auditions, run 3 saved as the production profile, its takes to
// review): the Overview's next step → the Voice page opens on the chosen run
// (★) at its takes → "Approve all takes" says what it did → "Storyboard this
// run →" → the Voice tab as Tulip Mania was left (every take approved, a
// name to decide) → the Storyboard page with that run chosen and named in
// words → planned (scripted model) → v1 → the next step says to review and
// approve it. Screenshots of each step go to GUIDED_OUT (OUT/guided by
// default).
// STORYBOARD_UI_ONLY=guided runs that walk alone.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3103';
const OUT = process.env.OUT ?? '/tmp/storyboard-ui';
const GUIDED_OUT = process.env.GUIDED_OUT ?? join(OUT, 'guided');
const ONLY = process.env.STORYBOARD_UI_ONLY ?? '';
const fixture = JSON.parse(process.env.FIXTURE ?? '{}');
if (!fixture.slug || !fixture.planSlug || !fixture.heldJob || !fixture.guided) throw new Error("FIXTURE (the fixture's READY line) is required");

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
/** 409 answers a check provokes on purpose (another tab saved first): the browser logs each as a failed resource, which is expected only then. */
let expectedConflicts = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
/** Polls until fn returns something truthy; a timeout stops this part of the run. */
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
/** Every visible button and folding summary in a part of the page is at least 24 px tall. */
const tapTargetsIn = async (page, selector, where) => {
  const small = await page.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} button, ${sel} summary`)]
        .filter((b) => b.offsetParent !== null)
        .map((b) => ({ t: b.textContent.trim().slice(0, 40), h: Math.round(b.getBoundingClientRect().height) }))
        .filter((b) => b.h < 24),
    selector,
  );
  check(!small.length, `${where}: every button is at least 24 px tall${small.length ? ` (${small.map((b) => `"${b.t}" ${b.h}px`).join(', ')})` : ''}`);
};
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
const section = (page, heading) => page.locator('section', { has: page.getByRole('heading', { name: heading }) });
const optionValue = (select, label) => select.locator('option').evaluateAll((os, l) => os.find((o) => o.textContent.trim().startsWith(l))?.value ?? null, label);

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
  return page;
}
const boardUrl = (slug, query = '') => `${BASE}/projects/${slug}/storyboard${query}`;
async function gotoBoard(page, slug, query = '') {
  await page.goto(boardUrl(slug, query));
  await page.getByRole('heading', { name: 'Storyboard', exact: true }).waitFor();
}
const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) });
async function openTab(page, name) {
  await tab(page, name).click();
  await until(async () => (await tab(page, name).getAttribute('aria-selected')) === 'true', `the ${name} tab selected`);
}
/** The version the page shows (from the URL once a version is chosen, else the panel). */
const shown = async (page) => Number(await page.locator('[role="tabpanel"]').getAttribute('data-version'));
/** Waits for the page to show version n. */
const showsVersion = (page, n, what) => until(async () => (await shown(page)) === n && new URL(page.url()).searchParams.get('v') === String(n), what);
const view = (api, v) => api('GET', `/api/projects/${fixture.slug}/storyboard${v ? `?v=${v}` : ''}`);

// ── Every tab, read only, on v1 ──────────────────────────────────────────────

async function tabs(width) {
  const tag = `${width} tabs`;
  const page = await open(width);
  try {
    await gotoBoard(page, fixture.slug, '?v=1');
    const picker = page.getByLabel('Storyboard version');
    check(/^v1 — In review — Planned from the narration · preview/.test((await picker.locator('option:checked').innerText()).trim()), `${tag}: the version picker shows "v1 — In review — Planned from the narration · preview"`);
    const pill = page.getByRole('navigation', { name: 'Project pages' }).getByRole('link', { name: /^Storyboard/ });
    check(/preview v1/.test(await text(pill)), `${tag}: the project nav has the Storyboard pill, "preview v1"`);
    const strip = page.locator('[data-inputs-strip]');
    const stripText = await text(strip);
    check(/^Script v\d+ · Architecture v\d+ · Voice run \d+ \(audition, blocks [\d.]+–[\d.]+\) · assembly v1 · takes \d+\/\d+ approved · Visual profile .+ v1 · engine v1 · Nothing is generated in this milestone/.test(stripText), `${tag}: the inputs strip says what v1 was planned from, and that nothing is generated (${stripText.split('\n')[0]})`);
    check(/Visual profile for the next plan:\s*Cinematic History v1 · the library default/.test(stripText), `${tag}: the strip says the next plan uses the library default, Cinematic History v1`);
    check((await page.locator('[role="tablist"] [role="tab"]').count()) === 7, `${tag}: seven tabs`);

    await openTab(page, 'Overview');
    const overview = page.locator('[data-overview]');
    check(/Estimated visual cost\s*(~\$[\d.]+ estimate|Unpriced)/.test(await text(overview)) && /a forecast, never spend/.test(await text(overview)), `${tag}: the overview's forecast is an estimate, never spend`);
    check((await page.locator('[data-approach]').count()) === 3 && /planned/.test(await text(page.locator('[data-approach="C"]'))), `${tag}: approaches A, B and C costed, C planned`);
    check((await page.locator('[data-version-row]').count()) >= 1 && /Actual cost: none yet, no assets/.test(await text(page.locator('[data-versions]'))), `${tag}: the versions list, with "actual cost: none yet"`);
    await overflow(page, `${tag} overview`);
    await tapTargetsIn(page, 'main', `${tag} overview`);
    await page.screenshot({ path: `${OUT}/${width}-overview.png`, fullPage: true });

    await openTab(page, 'Timeline');
    if (width >= 640) {
      const lanes = page.locator('[data-timeline]');
      const box = await lanes.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      check(box.sw > box.cw, `${tag}: the timeline's lanes scroll inside their own box (${box.sw}/${box.cw})`);
      for (const lane of ['Narration (blocks, cut points, silences)', 'Visual beats', 'Shots', 'Treatment', 'Information class']) check((await lanes.getByText(lane, { exact: true }).count()) === 1, `${tag}: the "${lane}" lane is labelled`);
      check((await lanes.locator('[data-lane-shot]').count()) === fixture.shots && (await lanes.locator('[data-lane-treatment]').count()) === fixture.shots, `${tag}: a box per shot on the shot and treatment lanes`);
      await page.getByRole('button', { name: 'Zoom in' }).click();
      check((await page.locator('[data-zoom]').getAttribute('data-zoom')) === '64', `${tag}: zoom in doubles the px per second`);
      await lanes.locator('[data-lane-shot="SH003"]').click();
    } else {
      check(!(await page.locator('[data-timeline]').isVisible()) && (await page.locator('[data-list-shot]').count()) === fixture.shots, `${tag}: on a phone the timeline is a list of the ${fixture.shots} shots in time order`);
      await page.locator('[data-list-shot="SH003"]').getByRole('button', { name: 'Open SH003' }).click();
    }
    await until(async () => (await tab(page, 'Shots').getAttribute('aria-selected')) === 'true', 'the shots tab from the timeline');
    const sh3 = page.locator('article[data-shot="SH003"]');
    check(/ring-2/.test((await sh3.getAttribute('class')) ?? '') && (await sh3.evaluate((el) => el.getBoundingClientRect().top < window.innerHeight)), `${tag}: a shot opened from the timeline is shown on the Shots tab, marked`);
    await openTab(page, 'Timeline');
    await overflow(page, `${tag} timeline`);
    await tapTargetsIn(page, 'main', `${tag} timeline`);
    await page.screenshot({ path: `${OUT}/${width}-timeline.png`, fullPage: true });

    await openTab(page, 'Shots');
    check((await page.locator('article[data-shot]').count()) === fixture.shots && (await page.locator('section[data-beat]').count()) === fixture.beats, `${tag}: ${fixture.shots} shot cards grouped by ${fixture.beats} beats`);
    const first = page.locator('article[data-shot="SH001"]');
    check(/Forecast:/.test(await text(first.locator('[data-shot-cost]'))) && /Timed to the narration|Leads in|Tails out|Bridges|Fills a silence/.test(await text(first)), `${tag}: a shot card has its relation to its words and its forecast`);
    await first.locator('[data-why] summary').click();
    const steps = await first.locator('[data-why-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-why-step')));
    check(['Shot', 'Visual beat', 'Narration', 'Script block'].every((s, i) => steps[i] === s) && steps.includes('Claim'), `${tag}: "Why is this visual here?" runs shot → visual beat → narration → script block → … → claims (${steps.join(' → ')})`);
    await overflow(page, `${tag} shots`);
    await tapTargetsIn(page, 'main', `${tag} shots`);
    await page.screenshot({ path: `${OUT}/${width}-shots.png`, fullPage: true });

    await openTab(page, 'Costs');
    check(/estimate|Unpriced/.test(await text(page.locator('[data-cost-total]'))) && /never spend/.test(await text(page.locator('[data-cost-total]'))), `${tag}: the costs tab's total is an estimate`);
    for (const t of ['By treatment', 'By method', 'By provider', 'By model', 'By section', 'By shot', 'Prices used']) check((await page.locator(`[data-table="${t}"]`).count()) === 1, `${tag}: the "${t}" table`);
    check((await page.locator('[data-table="By shot"] tbody tr').count()) === fixture.shots, `${tag}: a cost row per shot`);
    const unpricedZero = await page.locator('[data-table="By shot"] tbody tr').evaluateAll((rows) => rows.filter((r) => /unpriced/i.test(r.textContent) && /\$0\.00/.test(r.textContent)).length);
    check(unpricedZero === 0, `${tag}: no unpriced shot reads $0`);
    await overflow(page, `${tag} costs`);
    await tapTargetsIn(page, 'main', `${tag} costs`);
    await page.screenshot({ path: `${OUT}/${width}-costs.png`, fullPage: true });

    await openTab(page, 'Evidence');
    check(/factual shots traced to a retrieved source/.test(await text(page.locator('[data-coverage]'))) && (await page.locator('[data-evidence-row]').count()) === fixture.shots, `${tag}: evidence coverage, and a row per shot`);
    await overflow(page, `${tag} evidence`);
    await tapTargetsIn(page, 'main', `${tag} evidence`);
    await page.screenshot({ path: `${OUT}/${width}-evidence.png`, fullPage: true });

    await openTab(page, 'Continuity');
    const subject = page.locator('article[data-subject]').first();
    check((await page.locator('article[data-subject]').count()) >= 1 && /Requires .+ continuity asset/.test(await text(subject)) && /Appears in:/.test(await text(subject)), `${tag}: a continuity subject with "Requires … continuity asset" and its appearances`);
    await overflow(page, `${tag} continuity`);
    await tapTargetsIn(page, 'main', `${tag} continuity`);
    await page.screenshot({ path: `${OUT}/${width}-continuity.png`, fullPage: true });

    await openTab(page, 'QA');
    check(/^Now: \d+ blocking, \d+ to check/.test(await text(page.locator('[data-qa-live] h3'))) && (await page.locator('[data-rhythm] dt').count()) >= 10 && (await page.locator('[data-normalization]').count()) === 1, `${tag}: live findings, the rhythm and the normalization list`);
    await overflow(page, `${tag} qa`);
    await tapTargetsIn(page, 'main', `${tag} qa`);
    await page.screenshot({ path: `${OUT}/${width}-qa.png`, fullPage: true });
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/${width}-tabs-failure.png`, fullPage: true }).catch(() => null);
  }
  await page.context().close();
}

// ── Versions, decisions and edits, at 1280 ───────────────────────────────────

async function versions() {
  const tag = '1280 versions';
  const page = await open(1280);
  const api = apiOf(page);
  try {
    await gotoBoard(page, fixture.slug, '?v=1&tab=shots');
    check(fixture.blocking.length === 0, `${tag}: the fixture's v1 has no blocking finding (${fixture.blocking.join(', ')})`);
    // Shot decisions: a new row each; a rejected shot stops the version's approval until it is cleared.
    const sh1 = page.locator('article[data-shot="SH001"]');
    await sh1.getByRole('button', { name: 'Approve SH001' }).click();
    await until(async () => /Approved/.test(await text(sh1.locator('header'))), 'SH001 approved');
    const sh2 = page.locator('article[data-shot="SH002"]');
    await sh2.getByLabel('Note on SH002').fill('Too literal (UI check)');
    await sh2.getByRole('button', { name: 'Reject' }).click();
    await until(async () => /Rejected/.test(await text(sh2.locator('header'))), 'SH002 rejected');
    check(/Rejected by \S+: “Too literal \(UI check\)”/.test(await text(sh2)), `${tag}: a shot decision reads with who and the note`);
    const decision = page.locator('[data-decision]');
    check(/SH002 is rejected: edit it, or clear the decision/.test(await text(decision)) && (await decision.getByRole('button', { name: 'Approve v1' }).isDisabled()), `${tag}: a rejected shot stops the version's approval, said so`);
    await sh2.getByRole('button', { name: 'Clear' }).click();
    await until(async () => /Not reviewed/.test(await text(sh2.locator('header'))), 'SH002 cleared');
    await until(async () => (await decision.getByRole('button', { name: 'Approve v1' }).isEnabled()), 'approve enabled');
    check(true, `${tag}: cleared, the version can be approved`);

    // Approve v1 (a preview, at version level): approved, never automatically, the project status unchanged.
    await decision.getByLabel('Decision note').fill('The opening reads well (UI check)');
    await decision.getByRole('button', { name: 'Approve v1' }).click();
    await until(async () => (await page.locator('[data-storyboard-status]').first().innerText()) === 'Approved', 'v1 approved');
    check(true, `${tag}: v1 approved at version level`);
    const project = await api('GET', `/api/projects/${fixture.slug}`);
    check(project.status === 'VOICE_REVIEW', `${tag}: approving a preview leaves the project in VOICE_REVIEW (${project.status})`);

    // Edit SH003 on v1: v2 is saved; v1 stays as it was, and approved.
    const before = await view(api, 1);
    const sh3 = page.locator('article[data-shot="SH003"]');
    await sh3.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.locator('form[data-shot-form="SH003"]');
    check(/Saving makes a new version with this shot changed; v1 is kept as it is\./.test(await text(form)), `${tag}: the edit form says v1 is kept`);
    await form.getByLabel('What is seen').fill('The ledger open on a trestle table, a quill beside it (UI check edit).');
    await form.getByLabel('Note on this edit (optional)').fill('A quieter picture');
    await form.getByRole('button', { name: 'Save SH003 as a new version' }).click();
    await showsVersion(page, 2, 'v2 shown');
    const picker = page.getByLabel('Storyboard version');
    const options = await picker.locator('option').allInnerTexts();
    check(options.some((o) => /^v2 — In review — Edited \(from v1\)/.test(o)) && options.some((o) => /^v1 — Approved — Planned from the narration/.test(o)), `${tag}: the version list has v2 (edited from v1) and v1, still approved (${options.join(' | ')})`);
    const v2 = await view(api, 2);
    const v1 = await view(api, 1);
    check(v2.storyboard.shots.find((s) => s.key === 'SH003').spec.description.startsWith('The ledger open') && v1.storyboard.shots.find((s) => s.key === 'SH003').spec.description === before.storyboard.shots.find((s) => s.key === 'SH003').spec.description, `${tag}: v2 has the edit; v1's SH003 is unchanged`);
    check(JSON.stringify(v1.storyboard.shots.map((s) => [s.key, s.contentHash, s.startMs, s.endMs])) === JSON.stringify(before.storyboard.shots.map((s) => [s.key, s.contentHash, s.startMs, s.endMs])) && v1.storyboard.status === 'APPROVED', `${tag}: every v1 shot keeps its content hash and times, and v1 stays approved`);
    check(/Approved \(carried from v1\)/.test(await text(page.locator('article[data-shot="SH001"] header'))) && /Not reviewed/.test(await text(page.locator('article[data-shot="SH003"] header'))), `${tag}: SH001's approval is carried to v2 ("carried from v1"); the edited SH003 is not reviewed`);
    await openTab(page, 'Overview');
    check(/SH003 changed: description/.test(await text(page.locator('[data-changes]'))), `${tag}: v2's overview lists what changed from v1 ("SH003 changed: description")`);
    await picker.selectOption('1');
    await showsVersion(page, 1, 'v1 shown again');
    check(/Approved by \S+ on \d{4}-\d{2}-\d{2}; the approval applies to v1: v2 differs in 1 shot\(s\)/.test(await text(page.locator('[data-status-note]'))), `${tag}: v1 says its approval applies to v1, v2 differing in 1 shot`);
    await openTab(page, 'Shots');
    check(/Editing: v2 is the newest version: edit it, or restore this one first/.test(await text(page.locator('[role="tabpanel"]'))) && (await page.locator('article[data-shot] [data-shot-actions]').count()) === 0, `${tag}: v1 can no longer be edited (v2 is the newest), and says so`);
    await page.screenshot({ path: `${OUT}/1280-v1-after-edit.png`, fullPage: true });

    // An edit refused because another tab saved v3: the form keeps what was typed, and is saved as v4 on purpose.
    await gotoBoard(page, fixture.slug, '?v=2&tab=shots');
    const sh4 = page.locator('article[data-shot="SH004"]');
    await sh4.getByRole('button', { name: 'Edit', exact: true }).click();
    const form4 = page.locator('form[data-shot-form="SH004"]');
    const typed = 'A wax seal pressed onto a contract (UI check race).';
    await form4.getByLabel('What is seen').fill(typed);
    await api('POST', `/api/storyboards/${v2.storyboard.id}/edits`, { expectedVersion: 2, ops: [{ op: 'updateShot', shotKey: 'SH005', patch: { mood: 'Tense (another tab).' } }] });
    expectedConflicts++;
    await form4.getByRole('button', { name: 'Save SH004 as a new version' }).click();
    const race = form4.locator('[data-race]');
    await race.waitFor();
    check(/v3 was saved since this page was read\. Your changes are still here/.test(await text(race)) && (await form4.getByLabel('What is seen').inputValue()) === typed, `${tag}: a 409 (v3 saved in another tab) keeps the form as typed`);
    await page.screenshot({ path: `${OUT}/1280-race.png`, fullPage: true });
    await race.getByRole('button', { name: 'Save as v4 anyway' }).click();
    await showsVersion(page, 4, 'v4 shown');
    const v4 = await view(api, 4);
    const v3 = await view(api, 3);
    check(v4.storyboard.shots.find((s) => s.key === 'SH004').spec.description === typed && v3.storyboard.shots.find((s) => s.key === 'SH005').spec.mood === 'Tense (another tab).', `${tag}: saved on purpose as v4; v3 (the other tab's) is kept`);

    // Split, merge, move a cut, reorder: each a new version, no model call.
    let version = 4;
    const next = async (what) => {
      version += 1;
      await showsVersion(page, version, what);
    };
    const splittable = await page.locator('article[data-shot]').evaluateAll((cards) => cards.filter((c) => [...c.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Split…')).map((c) => c.getAttribute('data-shot')));
    let split = null;
    for (const key of splittable) {
      const card = page.locator(`article[data-shot="${key}"]`);
      await card.getByRole('button', { name: 'Split…' }).click();
      if ((await card.locator(`form[data-split="${key}"]`).count()) === 1) {
        split = key;
        await card.getByRole('button', { name: 'Split (new version)' }).click();
        break;
      }
      await card.getByRole('button', { name: 'Split…' }).click();
    }
    if (split) {
      await next('split');
      const after = await view(api, version);
      check(after.storyboard.shotCount === fixture.shots + 1, `${tag}: splitting ${split} saved v${version} with one shot more (${after.storyboard.shotCount})`);
      const merge = page.locator(`article[data-shot="${split}"]`).getByRole('button', { name: /^Merge with SH\d+/ });
      await merge.click();
      await next('merge');
      check((await view(api, version)).storyboard.shotCount === fixture.shots, `${tag}: merging it back saved v${version} (${fixture.shots} shots)`);
    } else check(false, `${tag}: some shot can be split at a cut point inside its words`);
    const movable = page.locator('article[data-shot]', { has: page.getByRole('button', { name: 'Move cut…' }) }).first();
    const left = await movable.getAttribute('data-shot');
    await movable.getByRole('button', { name: 'Move cut…' }).click();
    const cut = movable.locator('form[data-move-cut]');
    const select = cut.getByRole('combobox');
    const values = await select.locator('option').evaluateAll((os) => os.map((o) => o.value));
    const current = await select.inputValue();
    const other = values.find((x) => x !== current);
    if (other) await select.selectOption(other);
    else await cut.getByLabel(/Nudge/).fill('300');
    await cut.getByRole('button', { name: 'Move the cut (new version)' }).click();
    await next('move cut');
    check(true, `${tag}: moving the cut after ${left} saved v${version}`);
    const down = page.getByRole('button', { name: /^Move shot SH\d+ down$/ }).first();
    if (await down.count()) {
      await down.click();
      await next('reorder');
      check(true, `${tag}: reordering a beat's shots saved v${version}`);
    }

    // Request changes on the newest version (a preview): changes requested, still editable.
    await page.locator('[data-decision]').getByRole('button', { name: 'Request changes' }).click();
    await until(async () => (await page.locator('[data-storyboard-status]').first().innerText()) === 'Changes requested', 'changes requested');
    check(true, `${tag}: "Request changes" sets v${version} to changes requested`);

    // Restore v1: a copy saved as the newest version.
    await gotoBoard(page, fixture.slug, '?v=1&tab=overview');
    await page.locator('[data-more] summary').click();
    await page.getByRole('button', { name: `Restore v1 as v${version + 1} (no model call)` }).click();
    await next('restore');
    check(/^v\d+ — In review — Restored \(from v1\)/.test((await page.getByLabel('Storyboard version').locator('option:checked').innerText()).trim()), `${tag}: restoring v1 saved v${version} "Restored (from v1)"`);

    // A cheaper alternative applied, by a person, as a new version.
    await openTab(page, 'Costs');
    const alternative = page.locator('[data-alternative]', { has: page.getByRole('button', { name: 'Apply → new version' }) }).first();
    if (await alternative.count()) {
      const apply = alternative.getByRole('button', { name: 'Apply → new version' });
      check(await apply.isDisabled(), `${tag}: a cheaper alternative needs its confirmation`);
      await alternative.getByRole('checkbox').check();
      await apply.click();
      await next('alternative');
      check(true, `${tag}: a cheaper alternative applied as v${version}`);
    } else console.log(`note ${tag}: no cheaper alternative can be applied on this version`);

    // The project's visual profile changed from the header; the version re-costed with it.
    const strip = page.locator('[data-inputs-strip]');
    await strip.getByRole('button', { name: 'Change' }).click();
    const selection = strip.locator('[data-visual-selection]');
    const family = selection.getByLabel('Visual profile', { exact: true });
    await until(async () => (await optionValue(family, 'Dark True Crime')) !== null, 'the profiles listed');
    await family.selectOption(await optionValue(family, 'Dark True Crime'));
    await selection.getByRole('button', { name: 'Use for this project' }).click();
    await until(async () => /Dark True Crime v1 · follows its current version/.test(await text(strip.locator('[data-profile-control]'))), 'production on Dark True Crime');
    check(true, `${tag}: the project's visual profile set to Dark True Crime from the header`);
    const recost = strip.locator('[data-recost]');
    await recost.waitFor();
    check(new RegExp(`v${version} was planned with Cinematic History v1; the project now plans with Dark True Crime v1`).test(await text(recost)), `${tag}: the version says it was planned with another profile`);
    await recost.getByRole('button', { name: `Re-cost v${version} with it (a new version, no model call)` }).click();
    await next('re-cost');
    await openTab(page, 'Overview');
    check(/Re-costed for another visual profile/.test(await page.getByLabel('Storyboard version').locator('option:checked').innerText()) && /Planned with\s*Dark True Crime v1/.test(await text(page.locator('[data-overview]'))), `${tag}: v${version} is re-costed with Dark True Crime v1`);

    // The profile changed in another tab: the choice made here is refused, kept until Reload.
    await strip.getByRole('button', { name: 'Change' }).click();
    const now = await api('GET', `/api/projects/${fixture.slug}/visual/selection`);
    await api('PUT', `/api/projects/${fixture.slug}/visual/selection`, { familyId: null, versionId: null, overrides: {}, revision: now.revision });
    await family.selectOption(await optionValue(family, 'Corporate Investigative'));
    expectedConflicts++;
    await selection.getByRole('button', { name: 'Use for this project' }).click();
    const refused = selection.locator('[data-selection-error]');
    await refused.waitFor();
    check(/changed in another tab/.test(await text(refused)) && (await family.locator('option:checked').innerText()).startsWith('Corporate Investigative'), `${tag}: a choice saved at an old revision is refused, the choice kept`);
    await refused.getByRole('button', { name: 'Reload' }).click();
    await until(async () => /the library default/.test(await text(strip.locator('[data-profile-control]'))), 'reloaded to the library default');
    check(true, `${tag}: Reload shows the choice made in the other tab`);

    // A continuity subject's design detail, with its basis: one said to rest on a claim must name it; an invented one is saved labelled so.
    await openTab(page, 'Continuity');
    const subject = page.locator('article[data-subject]').first();
    const subjectKey = await subject.getAttribute('data-subject');
    await subject.getByRole('button', { name: `Edit ${subjectKey}` }).click();
    const subjectForm = subject.locator(`form[data-subject-form="${subjectKey}"]`);
    await subjectForm.getByRole('button', { name: 'Add a design detail' }).click();
    const row = await subjectForm.locator('select[aria-label$=" basis"]').count();
    await subjectForm.getByLabel(`Design detail ${row}`, { exact: true }).fill('A red guild sash (UI check)');
    await subjectForm.getByLabel(`Design detail ${row} basis`).selectOption('CLAIM');
    const saveSubject = subjectForm.getByRole('button', { name: `Save ${subjectKey} as a new version` });
    check(/rests on a claim: name it/.test(await text(subjectForm)) && (await saveSubject.isDisabled()), `${tag}: a design detail said to rest on a claim must name its claim`);
    await subjectForm.getByLabel(`Design detail ${row} basis`).selectOption('INVENTED');
    await saveSubject.click();
    await next('continuity edit');
    const edited = (await view(api, version)).storyboard.continuity.find((x) => x.key === subjectKey);
    check(edited.spec.designDetails.some((d) => d.detail === 'A red guild sash (UI check)' && d.basis === 'INVENTED') && /A red guild sash \(UI check\)\s*Invented/.test(await text(page.locator(`article[data-subject="${subjectKey}"]`))), `${tag}: the design detail is saved as v${version}, labelled invented`);

    // Another approach: a paid planning job (the scripted model here), confirmed; a new version when it is saved.
    // The page as a person opens it, on the newest version.
    await gotoBoard(page, fixture.slug, '?tab=overview');
    const a = page.locator('[data-approach="A"]');
    await a.getByRole('button', { name: 'Switch to A…' }).click();
    const plan = a.getByRole('button', { name: 'Plan approach A' });
    check(await plan.isDisabled(), `${tag}: switching approach needs its confirmation`);
    await a.getByRole('checkbox').check();
    // Another tab saves a version meanwhile, and this page reads it when its tab is shown again: the tick was for the version it was given on.
    const shownNow = await view(api, version);
    await api('POST', `/api/storyboards/${shownNow.storyboard.id}/edits`, { expectedVersion: version, ops: [{ op: 'updateShot', shotKey: shownNow.storyboard.shots[0].key, patch: { mood: 'Still (another tab).' } }] });
    version += 1;
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await until(async () => (await shown(page)) === version, "the other tab's version shown");
    check(!(await a.getByRole('checkbox').isChecked()) && (await plan.isDisabled()), `${tag}: a confirmation given on v${version - 1} does not carry to v${version}: switching approach asks again`);
    await a.getByRole('checkbox').check();
    await plan.click();
    await until(async () => /Another approach/.test(await page.getByLabel('Storyboard version').locator('option').first().innerText()), 'the approach version saved', 60_000);
    check(true, `${tag}: approach A planned as a new version ("Another approach")`);
    await overflow(page, `${tag} after the flows`);
    await page.screenshot({ path: `${OUT}/1280-versions.png`, fullPage: true });
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/1280-versions-failure.png`, fullPage: true }).catch(() => null);
  }
  await page.context().close();
}

// ── A preview planned from the page, and the project page ────────────────────

async function planning() {
  const tag = '1280 planning';
  const page = await open(1280);
  try {
    await gotoBoard(page, fixture.planSlug);
    const form = page.locator('[data-plan-form]');
    await form.waitFor();
    check(/^Voice run \d+ · .+ · \d+\/\d+ takes approved · \d+:\d\d( · ★ your chosen run)?$/.test((await text(form.locator('[data-plan-run]'))).trim()), `${tag}: the plan form names its run in words (${await text(form.locator('[data-plan-run]'))})`);
    await form.locator('[data-plan-choices] summary').click();
    check(/takes \d+\/\d+ approved/.test(await text(form)) && /the timing is real audio but provisional/.test(await text(form)), `${tag}: the plan form says the takes are not all approved (provisional timing)`);
    const confirm = form.getByRole('checkbox', { name: /I confirm a paid planning job \(a preview: the project status does not change\): model calls only, at most \$[\d.]+ \(the planning ceiling\)\. Nothing is generated/ });
    const go = form.getByRole('button', { name: 'Plan the storyboard (preview)' });
    check(!(await confirm.isChecked()) && (await go.isDisabled()), `${tag}: planning needs its confirmation`);
    await confirm.check();
    await form.getByLabel('Approach', { exact: true }).selectOption('B');
    check(!(await confirm.isChecked()) && (await go.isDisabled()), `${tag}: changing the request after the confirmation asks again`);
    await confirm.check();
    await overflow(page, `${tag} plan form`);
    await tapTargetsIn(page, 'main', `${tag} plan form`);
    await page.screenshot({ path: `${OUT}/1280-plan.png`, fullPage: true });
    await go.click();
    await until(async () => (await page.getByLabel('Storyboard version').count()) === 1, 'the planned version', 60_000);
    check(/^v1 — In review — Planned from the narration · preview/.test((await page.getByLabel('Storyboard version').locator('option:checked').innerText()).trim()), `${tag}: the preview is planned as v1, in review`);
    check(/provisional timing/.test(await text(page.locator('[data-inputs-strip]'))) && /B — Evidence-led/.test(await text(page.locator('[data-overview]'))), `${tag}: v1 is on provisional timing, planned with approach B as asked`);
    const decision = page.locator('[data-decision]');
    check(/approve the takes it is timed on first \(0\/\d+ approved, on the Voice page\)/.test(await text(decision)) && (await decision.getByRole('button', { name: 'Approve v1' }).isDisabled()), `${tag}: approving v1 waits for the takes`);
    const project = await apiOf(page)('GET', `/api/projects/${fixture.planSlug}`);
    check(project.status === 'VOICE_REVIEW', `${tag}: the preview leaves the project in VOICE_REVIEW`);

    await page.goto(`${BASE}/projects/${fixture.planSlug}`);
    const card = page.locator('[data-storyboard-card]');
    await card.waitFor();
    check(/^v1 · In review · preview · \d+:\d\d\.\d · \d+ beats, \d+ shots/.test(await text(card)) && /an estimate; nothing is generated/.test(await text(card)), `${tag}: the project page's storyboard card`);
    check(/preview v1/.test(await text(page.getByRole('navigation', { name: 'Project pages' }).getByRole('link', { name: /^Storyboard/ }))), `${tag}: the Storyboard pill says "preview v1"`);
    const next = page.locator('[data-next-step]');
    check(/Approve the takes of Voice run \d+ \(audition\): 0 of \d+ approved; then approve storyboard v1\./.test(await text(next)) && (await next.getByRole('link', { name: /^Approve run \d+'s takes →$/ }).count()) === 1, `${tag}: the next step says to approve the takes v1 is timed on, then v1 (${(await text(next)).replace(/\s+/g, ' ')})`);
    const stage = page.locator('ol li', { hasText: 'Storyboard' }).getByRole('link');
    check((await stage.count()) === 1 && /\/storyboard$/.test((await stage.getAttribute('href')) ?? ''), `${tag}: the pipeline's Storyboard stage links its page`);
    check((await page.getByRole('button', { name: /Visual generation|Infographic/ }).count()) === 0, `${tag}: no visual generation button`);
    // An old placeholder generation job: its retry is held on the page, and refused by the server.
    const heldRow = page.locator('tr', { has: page.locator('[data-retry-held]') });
    check((await heldRow.count()) === 1 && /held: the next milestone/.test(await text(heldRow)) && (await heldRow.getByRole('button', { name: 'Retry' }).count()) === 0, `${tag}: an old visual generation job offers no Retry ("held: the next milestone")`);
    expectedConflicts++;
    const refused = await apiOf(page)('POST', `/api/jobs/${fixture.heldJob}/retry`).then(
      () => null,
      (e) => e.message,
    );
    check(/: 409 Visual generation is the next milestone/.test(refused ?? ''), `${tag}: the server refuses that retry too (${refused})`);
    await overflow(page, `${tag} project page`);
    await page.screenshot({ path: `${OUT}/1280-project.png`, fullPage: true });
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/1280-planning-failure.png`, fullPage: true }).catch(() => null);
  }
  await page.context().close();
}

// ── The guided flow: from "I chose run 3" to a planned storyboard ────────────

/** The next step card: its sentence and its one button; on screen without scrolling (where the page opens at its top). */
async function nextStepOf(page, where) {
  const card = page.locator('[data-next-step]');
  await card.waitFor();
  const box = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
  });
  const height = page.viewportSize().height;
  check(box.top >= 0 && box.bottom <= height, `${where}: the next step is on screen without scrolling (${Math.round(box.top)}–${Math.round(box.bottom)} of ${height} px from the top)`);
  check((await card.getByRole('link').count()) === 1, `${where}: the next step has one button`);
  return { card, text: (await text(card.locator('p').nth(1))).trim(), button: card.getByRole('link') };
}
/** No internal code reaches the person (INCOMPLETE_NARRATION, TAKE_UNREVIEWED…). */
const noCodes = async (page, where) => {
  const codes = (await page.locator('main').innerText()).match(/\b[A-Z]{3,}(?:_[A-Z]+)+\b/g) ?? [];
  check(!codes.length, `${where}: no internal codes shown${codes.length ? ` (${[...new Set(codes)].join(', ')})` : ''}`);
};

async function guided(width) {
  const tag = `${width} guided`;
  const g = fixture.guided[width];
  const page = await open(width);
  const shot = (step) => page.screenshot({ path: join(GUIDED_OUT, `${width}-${step}.png`) });
  try {
    // 1. The Overview: one sentence, one button, to the chosen run's takes.
    await page.goto(`${BASE}/projects/${g.slug}`);
    let next = await nextStepOf(page, `${tag} overview`);
    check(next.text === `Approve the takes of Voice run ${g.run} (C expressive): 0 of ${g.chunks} approved.`, `${tag}: the Overview's next step is to approve run ${g.run}'s takes ("${next.text}")`);
    check((await text(next.button)).trim() === `Approve run ${g.run}'s takes →`, `${tag}: its button says "Approve run ${g.run}'s takes →"`);
    await overflow(page, `${tag} overview`);
    await shot('1-overview');

    // 2. The Voice page opens on the chosen run (★), at its takes.
    await next.button.click();
    await page.waitForURL(new RegExp(`/voice\\?run=${g.run}#takes$`));
    const takes = page.locator('#takes');
    await takes.waitFor();
    const picked = (await page.getByLabel('Voice run', { exact: true }).locator('option:checked').innerText()).trim();
    check(new RegExp(`^Run ${g.run} · C expressive · 0/${g.chunks} approved · ★ your chosen run$`).test(picked), `${tag}: the run picker shows run ${g.run}, starred ("${picked}")`);
    const options = await page.getByLabel('Voice run', { exact: true }).locator('option').allInnerTexts();
    check(options.length === g.runs && options.every((o) => /· \d+\/\d+ approved/.test(o)) && options.filter((o) => o.includes('★')).length === 1, `${tag}: every run lists its approved takes; only one is starred`);
    check((await page.locator('[data-chosen-run]').innerText()).trim() === '★ your chosen run', `${tag}: "★ your chosen run" beside the picker`);
    await until(async () => {
      const b = await takes.boundingBox();
      return b && b.y >= -2 && b.y < page.viewportSize().height / 2;
    }, 'the takes in view', 5_000);
    check(true, `${tag}: the page opens at the run's takes`);
    const storyboard = takes.locator('[data-storyboard-run]');
    check(/Approve this run's takes first/.test(await text(storyboard)) && (await storyboard.getByRole('button', { name: 'Storyboard this run →' }).isDisabled()), `${tag}: "Storyboard this run →" waits: "Approve this run's takes first"`);
    const approveAll = takes.getByRole('button', { name: 'Approve all takes without blocking findings' });
    check(await approveAll.isEnabled(), `${tag}: the approve button is next to it`);
    // What stops only the final narration is apart, in plain words, and says it does not stop storyboarding.
    const final = section(page, 'Before this can be the final narration');
    check(/Narrate the whole script/.test(await text(final)) && /None of this stops approving takes or storyboarding this audition/.test(await text(final)) && !/Blocks approval/.test(await text(final)), `${tag}: "Before this can be the final narration" holds the audition's whole-script finding, and does not stop storyboarding`);
    check(/Decide how names are said/.test(await text(final)) && (await text(final)).includes(g.term) && !(await text(takes)).includes(g.term), `${tag}: the name to decide (${g.term}) is with the final narration's findings, not the takes'`);
    await noCodes(page, `${tag} voice page`);
    await overflow(page, `${tag} voice page`);
    await tapTargetsIn(page, '#takes', `${tag} takes`);
    await shot('2b-voice-takes');
    await final.screenshot({ path: join(GUIDED_OUT, `${width}-2c-final-narration.png`) });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('2a-voice-top');
    next = await nextStepOf(page, `${tag} voice page`);
    check(next.text.startsWith(`Approve the takes of Voice run ${g.run}`), `${tag}: the Voice page's next step is the same ("${next.text}")`);

    // 3. Approve all: it says what it did; then the storyboard is one press away.
    await approveAll.click();
    const said = takes.locator('[data-approve-all-result]');
    await said.waitFor();
    check((await text(said)).trim() === `Approved ${g.chunks} takes`, `${tag}: "Approve all" says "Approved ${g.chunks} takes" ("${await text(said)}")`);
    await until(async () => (await takes.getByRole('link', { name: 'Storyboard this run →' }).count()) === 1, '"Storyboard this run →" enabled');
    check(new RegExp(`${g.chunks}/${g.chunks} takes approved`).test(await text(takes.locator('[data-takes-approved]'))), `${tag}: ${g.chunks}/${g.chunks} takes approved`);
    const again = await apiOf(page)('POST', `/api/voice/runs/${await page.evaluate(async ([slug, run]) => (await (await fetch(`/api/projects/${slug}/voice?run=${run}`)).json()).run.id, [g.slug, g.run])}/approve-all`);
    check(again.approved === 0 && again.alreadyApproved === g.chunks && again.total === g.chunks, `${tag}: pressed again, the API says all ${g.chunks} were already approved`);
    await until(async () => (await text(page.locator('[data-next-step]'))).includes(`Plan the storyboard for Voice run ${g.run} (C expressive).`), 'the next step moves on');
    check(true, `${tag}: the next step moves on to "Plan the storyboard for Voice run ${g.run} (C expressive)."`);
    await shot('3-approved');

    // 3b. As Tulip Mania was left: every take approved, a name to decide. The Voice tab (no run named) opens on the chosen run,
    // says its takes are approved, and the way on is one press; the name is decided on the Pronunciation tab, a link away.
    await page.getByRole('navigation', { name: 'Project pages' }).getByRole('link', { name: /^Voice/ }).click();
    await page.waitForURL(new RegExp(`/projects/${g.slug}/voice$`));
    await takes.waitFor();
    check(new RegExp(`^Run ${g.run} · C expressive · ${g.chunks}/${g.chunks} approved · ★ your chosen run$`).test((await page.getByLabel('Voice run', { exact: true }).locator('option:checked').innerText()).trim()), `${tag}: the Voice tab opens on run ${g.run}, starred, every take approved`);
    check(/every take of this run is approved/.test(await text(takes)) && (await takes.getByRole('link', { name: 'Storyboard this run →' }).count()) === 1 && (await takes.getByRole('button', { name: /Approve all takes/ }).count()) === 0, `${tag}: its takes say they are all approved, with "Storyboard this run →" (no approve button to press for nothing)`);
    next = await nextStepOf(page, `${tag} voice tab`);
    check(next.text === `Plan the storyboard for Voice run ${g.run} (C expressive).`, `${tag}: the Voice tab's next step is to plan the storyboard ("${next.text}")`);
    const tabsNav = page.getByRole('navigation', { name: 'Project pages' });
    check(/takes approved/.test(await text(tabsNav.getByRole('link', { name: /^Voice/ }))) && /bg-amber-100/.test((await tabsNav.getByRole('link', { name: /^Storyboard/ }).locator('span').getAttribute('class')) ?? ''), `${tag}: the project's tabs say the takes are approved and mark the Storyboard tab`);
    await shot('3b-voice-tab');
    await final.getByRole('button', { name: 'Decide them on the Pronunciation tab' }).click();
    await until(async () => (await page.getByRole('tab', { name: /^Pronunciation/ }).getAttribute('aria-selected')) === 'true', 'the Pronunciation tab open');
    check((await text(page.locator('#voice-panel'))).includes(g.term), `${tag}: "Decide them on the Pronunciation tab" opens it, ${g.term} listed`);
    await page.getByRole('tab', { name: `Voice run ${g.run}` }).click();
    await takes.waitFor();

    // 4. "Storyboard this run →": the Storyboard page, the run chosen and named in words, the ceiling, the confirmation.
    await takes.getByRole('link', { name: 'Storyboard this run →' }).click();
    await page.waitForURL(new RegExp(`/storyboard\\?run=${g.run}#plan$`));
    const form = page.locator('[data-plan-form]');
    await form.waitFor();
    const named = (await text(form.locator('[data-plan-run]'))).trim();
    check(new RegExp(`^Voice run ${g.run} · C expressive · ${g.chunks}/${g.chunks} takes approved · \\d+:\\d\\d · ★ your chosen run$`).test(named), `${tag}: the plan names the run in words ("${named}")`);
    const plan = page.locator('#plan');
    const planBox = await plan.boundingBox();
    check(!!planBox && planBox.y < page.viewportSize().height, `${tag}: the plan is the first thing below the title`);
    const confirm = form.getByRole('checkbox', { name: /I confirm a paid planning job \(a preview: the project status does not change\): model calls only, at most \$[\d.]+ \(the planning ceiling\)/ });
    const go = form.getByRole('button', { name: 'Plan the storyboard (preview)' });
    check(!(await confirm.isChecked()) && (await go.isDisabled()), `${tag}: planning states its ceiling and waits for the confirmation`);
    await form.locator('[data-plan-choices] summary').click();
    check(/^Voice run \d+ · C expressive/.test((await form.getByLabel('Voice run', { exact: true }).locator('option:checked').innerText()).trim()), `${tag}: run ${g.run} is the one chosen in the form`);
    await form.locator('[data-plan-choices] summary').click();
    next = await nextStepOf(page, `${tag} storyboard page`);
    check(next.text === `Plan the storyboard for Voice run ${g.run} (C expressive).`, `${tag}: the Storyboard page's next step is to plan it`);
    await noCodes(page, `${tag} plan`);
    await overflow(page, `${tag} plan`);
    await shot('4-plan');

    // 5. Planned: v1, in review.
    await confirm.check();
    await go.click();
    await until(async () => (await page.getByLabel('Storyboard version').count()) === 1, 'v1 planned', 90_000);
    check(/^v1 — In review — Planned from the narration · preview/.test((await page.getByLabel('Storyboard version').locator('option:checked').innerText()).trim()), `${tag}: v1 is planned, in review`);
    check(new RegExp(`Voice run ${g.run} \\(audition`).test(await text(page.locator('[data-inputs-strip]'))) && !/provisional timing/.test(await text(page.locator('[data-inputs-strip]'))), `${tag}: v1 is timed on run ${g.run}, its takes approved`);
    await shot('5-v1');

    // 6. The next step says to review and approve it, and goes to the decision.
    await until(async () => (await text(page.locator('[data-next-step]'))).includes('Review storyboard v1 and approve it.'), 'the next step: review v1');
    next = await nextStepOf(page, `${tag} v1`);
    check((await text(next.button)).trim() === 'Review storyboard v1 ↓', `${tag}: the next step is "Review storyboard v1 and approve it." with "Review storyboard v1 ↓" (further down this page)`);
    await next.button.click();
    await page.waitForURL(/[?&]v=1#decision$/);
    const decision = page.locator('#decision');
    await until(async () => {
      const b = await decision.boundingBox();
      return b && b.y >= -2 && b.y < page.viewportSize().height / 2;
    }, 'the decision in view', 5_000);
    check((await decision.getByRole('button', { name: 'Approve v1' }).count()) === 1, `${tag}: the decision on v1 is in view, with "Approve v1"`);
    await overflow(page, `${tag} review`);
    await shot('6-review');
    await page.goto(`${BASE}/projects/${g.slug}`);
    next = await nextStepOf(page, `${tag} overview after`);
    check(next.text === 'Review storyboard v1 and approve it.', `${tag}: the Overview says the same ("${next.text}")`);
    await shot('7-overview-after');
    if (width === 1280) {
      // Approved, the preview leads on to the whole narration.
      await next.button.click();
      await page.locator('#decision').getByRole('button', { name: 'Approve v1' }).click();
      await until(async () => (await text(page.locator('[data-next-step]'))).includes('Storyboard v1 is approved. Narrate the whole script'), 'the next step after approval');
      check((await text(page.locator('[data-next-step]').getByRole('link'))).trim() === 'Narrate the whole script →', `${tag}: approved, the next step is to narrate the whole script`);
      await page.locator('[data-next-step]').getByRole('link').click();
      await page.getByRole('tab', { name: 'Audition & generate' }).waitFor();
      await until(async () => (await page.getByRole('tab', { name: 'Audition & generate' }).getAttribute('aria-selected')) === 'true', 'the generate tab open');
      check((await page.getByLabel(/^Scope/).inputValue()) === 'FULL', `${tag}: "Narrate the whole script →" opens the Voice page's Audition & generate tab with the whole script chosen`);
      await shot('8-whole-script');
      // Another run saved and used as the production profile from this page: the ★ moves, the page stays where it is (its confirmation kept).
      await page.goto(`${BASE}/projects/${g.slug}/voice`);
      const e = page.locator('#voice-panel [data-variant="E no context"]');
      await e.waitFor();
      await e.getByRole('button', { name: "Save this run's configuration as a voice profile" }).click();
      await e.getByLabel('Profile name').fill(`House Documentary — No context (${width})`);
      await e.getByRole('button', { name: 'Save profile' }).click();
      await e.getByRole('button', { name: 'Use for this project' }).click();
      await until(async () => (await e.getByText('In use for this project').count()) === 1, 'the profile in use');
      const other = Number((await e.innerText()).match(/run (\d+)/)?.[1]);
      await until(async () => (await page.getByRole('button', { name: `★ Go to your chosen run (run ${other})` }).count()) === 1, 'the ★ on the other run');
      check(new RegExp(`^Run ${g.run} · `).test((await page.getByLabel('Voice run', { exact: true }).locator('option:checked').innerText()).trim()) && (await e.getByText('In use for this project').count()) === 1, `${tag}: using run ${other}'s profile moves the ★ to it ("★ Go to your chosen run (run ${other})") while the page stays on run ${g.run}, the confirmation in view`);
    }
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: join(GUIDED_OUT, `${width}-failure.png`), fullPage: true }).catch(() => null);
  }
  await page.context().close();
}

// ── An edit from a phone ─────────────────────────────────────────────────────

async function phoneEdit(width) {
  const tag = `${width} edit`;
  const page = await open(width);
  const api = apiOf(page);
  try {
    await gotoBoard(page, fixture.slug, '?tab=shots');
    const newest = (await view(api)).versions[0].version;
    // The newest version's keys (a re-planned approach gives its new shots new keys): its last shot.
    const key = await page.locator('article[data-shot]').last().getAttribute('data-shot');
    const card = page.locator(`article[data-shot="${key}"]`);
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.locator(`form[data-shot-form="${key}"]`);
    await form.getByLabel('Mood').fill(`Hushed (UI check ${width}).`);
    // A specific detail with its basis: one said to rest on a claim must name it; an invented one is saved labelled so.
    await form.getByRole('button', { name: 'Add a detail' }).click();
    const n = await form.locator('select[aria-label^="Detail "][aria-label$=" kind"]').count();
    await form.getByLabel(`Detail ${n}`, { exact: true }).fill(`A wool cap (UI check ${width})`);
    await form.getByLabel(`Detail ${n} kind`).selectOption('CLOTHING');
    await form.getByLabel(`Detail ${n} basis`).selectOption('CLAIM');
    const save = form.getByRole('button', { name: `Save ${key} as a new version` });
    check(/rests on a claim: name it/.test(await text(form)) && (await save.isDisabled()), `${tag}: a detail said to rest on a claim must name its claim`);
    await form.getByLabel(`Detail ${n} basis`).selectOption('INVENTED');
    await overflow(page, `${tag} form`);
    await tapTargetsIn(page, 'main', `${tag} form`);
    await page.screenshot({ path: `${OUT}/${width}-edit-form.png`, fullPage: true });
    await save.click();
    await showsVersion(page, newest + 1, 'the edit saved');
    const saved = (await view(api, newest + 1)).storyboard.shots.find((s) => s.key === key).spec;
    check(saved.mood === `Hushed (UI check ${width}).` && saved.specifics.some((d) => d.detail === `A wool cap (UI check ${width})` && d.kind === 'CLOTHING' && d.basis === 'INVENTED'), `${tag}: an edit of ${key} from a phone saves v${newest + 1}, its invented detail labelled so`);
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/${width}-edit-failure.png`, fullPage: true }).catch(() => null);
  }
  await page.context().close();
}

// ── The visual profile library ───────────────────────────────────────────────

const PRESETS = ['Cinematic History', 'Corporate Investigative', 'Dark True Crime', 'Clean Business Explainer', 'Retro Documentary'];

async function library(width) {
  const tag = `${width} library`;
  const page = await open(width);
  const api = apiOf(page);
  const name = `UI look ${width}`;
  try {
    await page.goto(`${BASE}/visual-profiles`);
    await page.getByRole('heading', { name: 'Visual profiles', exact: true }).waitFor();
    check(await page.locator('header').getByRole('link', { name: 'Visual profiles' }).isVisible(), `${tag}: the header links the visual profiles`);
    for (const preset of PRESETS) check((await page.locator(`article[data-profile="${preset}"]`).count()) === 1, `${tag}: the preset "${preset}" is listed`);
    const cinematic = page.locator('article[data-profile="Cinematic History"]');
    check(/library default/.test(await text(cinematic)) && (await cinematic.getByRole('button', { name: 'Archive', exact: true }).isDisabled()), `${tag}: Cinematic History is the library default, and cannot be archived`);
    await overflow(page, `${tag} list`);
    await tapTargetsIn(page, 'main', `${tag} list`);
    await page.screenshot({ path: `${OUT}/library-${width}-list.png`, fullPage: true });

    // A new profile: v1 with what the form set.
    await page.getByRole('button', { name: 'New profile' }).click();
    const form = page.locator('form[data-profile-form="new"]');
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Visual density', { exact: true }).selectOption('SPARSE');
    await form.getByLabel('Generated video at most (% of the runtime)', { exact: true }).fill('150');
    check(/To fix: Generated video at most \(% of the runtime\): not a valid value/.test(await text(form)) && (await form.getByRole('button', { name: 'Create the profile' }).isDisabled()), `${tag}: a share over 100% is refused before saving`);
    await form.getByLabel('Generated video at most (% of the runtime)', { exact: true }).fill('20');
    await form.getByRole('button', { name: 'Add a provider preference' }).click();
    await form.getByLabel('Preference 1 provider').fill('acme-unknown');
    await overflow(page, `${tag} new profile form`);
    await tapTargetsIn(page, 'form', `${tag} new profile form`);
    await page.screenshot({ path: `${OUT}/library-${width}-new.png`, fullPage: true });
    await form.getByRole('button', { name: 'Create the profile' }).click();
    await page.waitForURL(/\/visual-profiles\/[0-9a-f-]{36}$/);
    const card = page.locator(`article[data-profile="${name}"]`);
    await card.waitFor();
    const v1 = page.locator('li[data-version="1"]');
    await v1.locator('summary').click();
    const v1Text = await text(v1);
    check(/made in the library/.test(v1Text) && /Sparse \(long shots\)/.test(v1Text) && /at most 20% of the runtime/.test(v1Text) && /acme-unknown/.test(v1Text), `${tag}: v1 is saved with what the form set`);
    check(/acme-unknown is not in the visual catalog/.test(await text(card)), `${tag}: an unknown provider preference is a warning, not a refusal`);

    // Edit: always a new version; the history says what changed.
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.locator('form[data-profile-form="edit"]');
    check(/Saves v2\. 0 projects follow this profile/.test(await text(edit.locator('[data-edit-note]'))), `${tag}: the edit says it saves v2 and who follows`);
    check(await edit.getByRole('button', { name: 'Save v2' }).isDisabled(), `${tag}: an edit that changes nothing is not saved`);
    await edit.getByLabel('Film grain', { exact: true }).selectOption('HEAVY');
    await edit.getByRole('button', { name: 'Save v2' }).click();
    const v2 = page.locator('li[data-version="2"]');
    await until(async () => (await v2.count()) === 1, 'v2 in the history');
    check(/current/.test(await text(v2)) && /an edit of v1/.test(await text(v2)) && /filmGrain: .+ → HEAVY/.test(await text(v2)), `${tag}: v2 is current and its history says what changed (filmGrain → HEAVY)`);
    await overflow(page, `${tag} history`);
    await tapTargetsIn(page, 'main', `${tag} history`);
    await page.screenshot({ path: `${OUT}/library-${width}-history.png`, fullPage: true });

    if (width === 1280) {
      // An edit opened before another tab saved v3: refused until seen, then saved on purpose as v4.
      await card.getByRole('button', { name: 'Edit', exact: true }).click();
      const stale = page.locator('form[data-profile-form="edit"]');
      await stale.getByLabel('Motion', { exact: true }).selectOption('HIGH');
      const familyId = page.url().split('/').at(-1);
      await api('POST', `/api/visual/profiles/${familyId}/versions`, { config: { lighting: 'Another tab.' } });
      expectedConflicts++;
      await stale.getByRole('button', { name: 'Save v3' }).click();
      const since = stale.locator('[data-edit-since]');
      await since.waitFor();
      check(/v3 was saved since this form opened/.test(await text(since)) && (await stale.getByLabel('Motion', { exact: true }).inputValue()) === 'HIGH', `${tag}: an edit refused because another tab saved v3 keeps its changes`);
      await since.getByRole('button', { name: 'Save v4 anyway' }).click();
      await until(async () => (await page.locator('li[data-version="4"]').count()) === 1, 'v4 saved');
      check(/motionIntensity: .+ → HIGH/.test(await text(page.locator('li[data-version="4"]'))), `${tag}: saved on purpose as v4`);
    }

    // Duplicate, rename the copy, archive and unarchive it.
    await card.getByRole('button', { name: 'Duplicate' }).click();
    const dup = page.locator('form[data-profile-form="duplicate"]');
    check((await dup.getByLabel('Name', { exact: true }).inputValue()) === `${name} copy`, `${tag}: a duplicate is offered "… copy"`);
    await dup.getByRole('button', { name: 'Create the copy' }).click();
    const copy = page.locator(`article[data-profile="${name} copy"]`);
    await copy.waitFor();
    await copy.getByRole('button', { name: 'Rename' }).click();
    await copy.locator('form[data-rename]').getByLabel('Name').fill(`${name} renamed`);
    await copy.locator('form[data-rename]').getByRole('button', { name: 'Save the name' }).click();
    const renamed = page.locator(`article[data-profile="${name} renamed"]`);
    await renamed.waitFor();
    check(true, `${tag}: the copy is renamed`);
    await renamed.getByRole('button', { name: 'Archive', exact: true }).click();
    await until(async () => /\barchived\b/.test(await text(renamed.locator('header'))), 'archived');
    await renamed.getByRole('button', { name: 'Unarchive' }).click();
    await until(async () => !/\barchived\b/.test(await text(renamed.locator('header'))), 'unarchived');
    check(true, `${tag}: the copy is archived and unarchived`);
    await page.goto(`${BASE}/visual-profiles`);
    await page.locator('[data-catalog] summary').click();
    check((await page.locator('[data-catalog-card]').count()) >= 1 && /nothing here is called, configured or bought/i.test(await text(page.locator('[data-catalog]'))), `${tag}: the catalog lists its cards and says nothing is called or bought`);
    await overflow(page, `${tag} catalog`);
    await tapTargetsIn(page, 'main', `${tag} catalog`);
  } catch (err) {
    check(false, `${tag}: ${err.message}`);
    await page.screenshot({ path: `${OUT}/library-${width}-failure.png`, fullPage: true }).catch(() => null);
  }
  await page.context().close();
}

mkdirSync(GUIDED_OUT, { recursive: true });
for (const width of [412, 1280]) await guided(width);
if (ONLY !== 'guided') {
  for (const width of [1280, 412, 360]) await tabs(width);
  await versions();
  await planning();
  for (const width of [412, 360]) await phoneEdit(width);
  for (const width of [1280, 412, 360]) await library(width);
}
await browser.close();
check(expectedConflicts === 0, `every conflict provoked on purpose was answered (${expectedConflicts} outstanding)`);
console.log(problems.length ? `console problems:\n${problems.join('\n')}` : 'no console errors or warnings');
console.log(failures.length ? `${failures.length} check(s) failed` : 'every check passed');
process.exit(failures.length || problems.length ? 1 : 0);
