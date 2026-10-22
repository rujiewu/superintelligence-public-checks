// Read-only acceptance of the actual Pages release; no fixtures or account flow.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hosting } from './hosting-config.mjs';
import { capsule, capsuleRunnerAllowed, capsuleContentInputs as prepareContentInputs } from './public-capsule.mjs';

const PAGES = hosting.pages_url;
const ORIGIN = new URL(PAGES).origin;
const BASE = hosting.site_base + '/';
const OUTPUT = 'test-results/public-content';
const MODULES = ['reading', 'learning', 'trading', 'investment'];
export const TARGETS = [
  { module: 'learning', id: 'd02-v33-u6', file: 'knowledge/lessons/d02-v33-u6.json', field: 'lesson', tableMarker: '最近秩 p95',
    markers: ['修好了，为什么换一台机器又失败', '最近秩 p95', '1300 毫秒', '干净环境'] },
  { module: 'trading', id: 'operational-reconciliation', file: 'knowledge/cases/operational-reconciliation.json', field: 'teaching_case', tableMarker: 'E1：卖 40 份',
    markers: ['订单取消了，成交与现金为什么还要核对', '一拆二', '2978', '12978'] },
  { module: 'reading', id: 'human-history-thousand', file: 'knowledge/plans/reading-thousand-program.md',
    markers: ['当前去重提名 184 部，独立入选 0 部', '每批怎样推进', '与另外三个系统的关系'] },
];
const VIEWS = [
  { name: 'desktop-light', width: 1440, height: 1000, theme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 1000, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, theme: 'light', mobile: true },
  { name: 'mobile-dark', width: 390, height: 844, theme: 'dark', mobile: true },
];

export function runnerAllowed(env) {
  return capsuleRunnerAllowed(env);
}

export function allowedPublicRequest(target, method, headers = {}) {
  let url;
  try { url = new URL(target); } catch { return false; }
  if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password
    || method !== 'GET' || Object.keys(headers).some(key => ['authorization', 'cookie'].includes(key.toLowerCase()))) return false;
  const path = url.pathname;
  if (MODULES.some(module => path === `${BASE}${module}/` || path === `${BASE}${module}`)) {
    return url.searchParams.get('read') === 'public';
  }
  return path === `${BASE}pages-manifest.json`
    || MODULES.some(module => path === `${BASE}data/catalog-${module}.json`)
    || new RegExp(`^${BASE}data/books/[a-z0-9-]+\\.json$`).test(path)
    || new RegExp(`^${BASE}(?:assets|book-assets)/[a-zA-Z0-9_./-]+$`).test(path);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(value).digest('hex');
export function teachingHash(value, field) {
  const normalized = JSON.parse(JSON.stringify(value));
  normalized.sections = normalized.sections.map(section => ({ ...section, source_ids: section.source_ids ?? [] }));
  normalized.sources = normalized.sources.map(source => ({ ...source, publication_date: source.publication_date ?? null }));
  if (field === 'teaching_case') {
    normalized.decision_date ??= null;
    normalized.information_cutoff ??= null;
  }
  return digest(canonical(normalized));
}

export function authoredBodyMatches(body, sections) {
  let after = 0;
  return sections.every(section => {
    const position = body.indexOf(`## ${section.title}\n\n${section.body}`, after);
    if (position < 0) return false;
    after = position + section.title.length + section.body.length + 5;
    return true;
  });
}

// Markdown fences are renderer syntax; code whitespace remains material content.
export function continuationParagraphExpectation(paragraph) {
  const text = String(paragraph).replace(/\r\n?/g, '\n');
  if (!/^(?:`{3,}|~{3,})/.test(text)) return { text, code: null };
  const opening = text.match(/^(`{3,}|~{3,})[a-zA-Z0-9_-]*[ \t]*\n/);
  if (!opening) throw new Error('Malformed standalone continuation code fence');
  const lines = text.slice(opening[0].length).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const closing = new RegExp(`^${opening[1][0]}{${opening[1].length},}[ \\t]*$`);
  const end = lines.findIndex(line => closing.test(line));
  if (end < 0 || end !== lines.length - 1) throw new Error('Malformed standalone continuation code fence');
  const code = lines.slice(0, end).join('\n');
  return { text: code, code };
}

// Book options keep their authored titles, including identifiers such as 1.1.
// Non-book options can add a separate "1. " navigation prefix.
export function studyOptionForTitle(title) {
  const options = document.querySelector('#study-section')?.options || [];
  return [...options].find(option => option.textContent === title
    || option.textContent.replace(/^\d+\.\s+/, '') === title)?.value;
}

// Views have independent browser contexts but share the original absolute deadline.
// Stop scheduling after a failure and drain already-running reads before closing Chromium.
export async function runBoundedViews(views, operation, concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new TypeError('Invalid view concurrency');
  let next = 0;
  const failures = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, views.length) }, async () => {
    while (failures.length === 0 && next < views.length) {
      const view = views[next++];
      try { await operation(view); } catch (error) { failures.push(error); }
    }
  }));
  if (failures.length) throw failures[0];
}

class ContentFailure extends Error {}
function requireTrue(value, code) { if (!value) throw new ContentFailure(code); }

export async function runAcceptance() {
  const started = Date.now(), jobStarted = Number(process.env.PUBLIC_CONTENT_JOB_STARTED_MS || started);
  const deadline = Math.min(started + 360_000, (Number.isFinite(jobStarted) ? jobStarted : started) + 780_000);
  const report = { schema_version: '1.0.0', status: 'RUNNING', scope: 'Actual public reading content only',
    pages_url: PAGES, run_id: process.env.GITHUB_RUN_ID || null,
    expected_source_commit: process.env.EXPECTED_SOURCE_SHA || null, started: new Date(started).toISOString(),
    checks: [], screenshots: [], blocked_requests: 0, console_errors: 0, page_errors: 0,
    limitations: ['No login, provider call, private read or learning-record write.',
      'Desktop and mobile are independent Chromium contexts with viewport emulation, not physical devices.',
      'Geometry and screenshots require human visual review; this report does not certify learning or book publication.',
      'Source links are checked in the published document; external sites are not automatically visited.'] };
  let stage = 'runner-guard', browser;
  mkdirSync(OUTPUT, { recursive: true, mode: 0o700 });
  const remaining = maximum => {
    const timeout = Math.min(maximum, deadline - Date.now());
    requireTrue(timeout > 0, 'CONTENT_DEADLINE');
    return timeout;
  };
  async function bounded(operation, maximum = 30_000) {
    const timeout = remaining(maximum);
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ContentFailure('OPERATION_DEADLINE')), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  const record = (name, fields = {}) => report.checks.push({ name, status: 'PASS', ...fields });
  async function publicJSON(path, cap = 8 * 1024 * 1024) {
    const target = PAGES + path;
    requireTrue(allowedPublicRequest(target, 'GET'), 'UNKNOWN_PUBLIC_FETCH');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining(30_000));
    try {
      return await bounded(async () => {
        const response = await fetch(target, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
        requireTrue(response.status === 200 && response.headers.get('content-type')?.includes('json'), 'PUBLIC_JSON_RESPONSE');
        const reader = response.body?.getReader();
        requireTrue(reader, 'PUBLIC_JSON_BODY');
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            requireTrue(size <= cap, 'PUBLIC_JSON_SIZE');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const raw = Buffer.concat(chunks); requireTrue(digest(raw) === capsule().files['dist/ui-preview/' + path], 'CAPSULE_PUBLIC_BYTES'); return JSON.parse(raw.toString('utf8'));
      });
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function ready(page, item) {
    await bounded(() => page.waitForFunction(title => document.documentElement.dataset.readOnly === 'true'
      && !document.querySelector('#app-shell')?.hidden && !document.querySelector('#detail-content')?.hidden
      && document.querySelector('#detail-title')?.textContent === title,
    item.title, { timeout: remaining(30_000) }));
    const isolated = await bounded(() => page.evaluate(() => document.querySelector('#note-answer')?.disabled
      && document.querySelector('#note-answer')?.value === '' && document.querySelector('#chat-input')?.disabled
      && document.querySelector('#chat-input')?.value === '' && document.querySelector('#history-drawer')?.hidden
      && document.querySelectorAll('[data-session-id]').length === 0
      && document.querySelectorAll('#chat-messages .message').length === 0), 10_000);
    requireTrue(isolated, 'PUBLIC_STATE_ISOLATION');
  }
  async function screenshot(page, filename) {
    await bounded(() => page.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled',
      mask: [page.locator('#password'), page.locator('#note-answer'), page.locator('#chat-input'),
        page.locator('#chat-messages'), page.locator('#history-drawer')] }));
    report.screenshots.push(filename);
  }
  try {
    requireTrue(runnerAllowed(process.env), 'OWNER_MAIN_PUBLIC_RUNNER_REQUIRED');
    stage = 'published-manifest';
    const manifest = await publicJSON('pages-manifest.json', 64 * 1024);
    requireTrue(manifest.source_commit === process.env.EXPECTED_SOURCE_SHA && manifest.kind === 'PUBLIC_ALLOWLIST_ONLY'
      && manifest.repository === hosting.source_repository && manifest.base === hosting.site_base
      && manifest.transport === 'shared' && manifest.private_records_exported === false
      && manifest.snapshot_exported === false && manifest.investment_personal_playbooks_exported === false,
    'MANIFEST_SOURCE_OR_PRIVATE_BOUNDARY');
    report.manifest = { source_commit: manifest.source_commit, kind: manifest.kind, modules: manifest.modules,
      published_books: manifest.published_books, private_records_exported: false,
      snapshot_exported: false, investment_personal_playbooks_exported: false };
    const catalogs = {};
    for (const module of MODULES) {
      const payload = await publicJSON(`data/catalog-${module}.json`);
      requireTrue(Array.isArray(payload.items) && payload.items.length === manifest.modules?.[module]
        && new Set(payload.items.map(item => item.id)).size === payload.items.length, 'CATALOG_COUNT_OR_ID');
      catalogs[module] = payload.items;
    }
    const { expansionPayloads, expansionSources, continuations, materials } = prepareContentInputs({
      catalogs, manifest, requireTrue, record, TARGETS, teachingHash, authoredBodyMatches });
    const { chromium } = await bounded(() => import('playwright'), 10_000);
    browser = await bounded(() => chromium.launch({ args: ['--no-proxy-server', '--disable-background-networking'] }));
    report.viewport_runs = [];
    await runBoundedViews(VIEWS, async view => {
      let stage = `${view.name}-start`;
      const viewportRun = { name: view.name, status: 'RUNNING' };
      report.viewport_runs.push(viewportRun);
      try {
      const context = await bounded(() => browser.newContext({ viewport: { width: view.width, height: view.height },
        colorScheme: view.theme, isMobile: Boolean(view.mobile), hasTouch: Boolean(view.mobile), serviceWorkers: 'block' }), 10_000);
      await bounded(() => context.route('**/*', async route => {
        const request = route.request();
        if (allowedPublicRequest(request.url(), request.method(), request.headers())) await route.continue();
        else { report.blocked_requests += 1; await route.abort('blockedbyclient'); }
      }), 10_000);
      const page = await bounded(() => context.newPage(), 10_000);
      page.on('pageerror', () => { report.page_errors += 1; });
      page.on('console', message => { if (message.type() === 'error') report.console_errors += 1; });
      page.on('dialog', dialog => dialog.dismiss());
      for (const material of materials) {
        stage = `${view.name}-${material.id}`;
        const url = `${PAGES}${material.module}/?read=public&resource=${material.id}`;
        const response = await bounded(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining(30_000) }));
        requireTrue(response?.status() === 200 && page.url() === url, 'PUBLIC_ROUTE_CHANGED');
        await ready(page, material.item);
        const result = await bounded(() => page.evaluate(({ headings, markers, sourceURLs, theme, itemTitle }) => {
          const body = document.querySelector('#detail-body'), panel = document.querySelector('#resource-detail');
          const text = document.querySelector('#text-section');
          const laidOut = node => Boolean(node?.getClientRects().length) && !node.closest('[hidden]')
            && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
          const parts = [...body.querySelectorAll('.study-part')], actualHeadings = parts.map(part => part.querySelector('h3')?.textContent);
          const headingPositions = headings.map(heading => actualHeadings.indexOf(heading));
          const rect = body.getBoundingClientRect(), tables = [...body.querySelectorAll('table.study-table')];
          const links = [...text.querySelectorAll('a[href]')];
          const hrefs = new Set(links.map(link => link.href));
          const external = links.filter(link => new URL(link.href).origin !== location.origin);
          const tableIndex = parts.findIndex(part => part.querySelector('table.study-table'));
          return { theme_matches: document.documentElement.dataset.theme === theme,
            body_overflow: document.documentElement.scrollWidth > innerWidth + 1,
            continuous_sections: headingPositions.every((position, index) => position >= 0
              && (!index || position > headingPositions[index - 1]) && laidOut(parts[position].querySelector('h3')))
              && parts.every(laidOut) && !body.querySelector('details:not([open])') && laidOut(text),
            required_markers: markers.every(marker => (itemTitle + '\n' + body.textContent).includes(marker)),
            source_links_complete: sourceURLs.every(url => hrefs.has(new URL(url).href)),
            external_links_safe: external.every(link => link.target === '_blank'
              && link.rel.split(/\s+/).includes('noopener') && link.rel.split(/\s+/).includes('noreferrer')
              && ['http:', 'https:'].includes(new URL(link.href).protocol)),
            prose_fits_column: [...body.querySelectorAll('p, pre')].every(node => {
              const bounds = node.getBoundingClientRect();
              return laidOut(node) && bounds.width > 0 && bounds.left >= rect.left - 2 && bounds.right <= rect.right + 2;
            }), table_count: tables.length,
            tables_fit_column: tables.length > 0 && tables.every(table => {
              const bounds = table.getBoundingClientRect(), columns = table.querySelectorAll('thead th');
              return laidOut(table) && bounds.left >= rect.left - 2 && bounds.right <= rect.right + 2
                && table.scrollWidth <= table.clientWidth + 2 && columns.length >= 2
                && [...columns].every(th => th.scope === 'col')
                && [...table.querySelectorAll('tbody tr')].every(row => row.children.length === columns.length
                  && [...row.children].every(cell => laidOut(cell.querySelector('.cell-value'))));
            }), section_count: parts.length, source_link_count: sourceURLs.length, table_section_index: tableIndex,
            panel_width: Math.round(panel.clientWidth), reading_width: Math.round(body.clientWidth) };
        }, { headings: material.headings, markers: material.markers, sourceURLs: material.sourceURLs,
          theme: view.theme, itemTitle: material.item.title }), 10_000);
        requireTrue(result.theme_matches && !result.body_overflow && result.continuous_sections && result.required_markers
          && result.source_links_complete && result.external_links_safe && result.prose_fits_column
          && result.tables_fit_column, 'PUBLIC_CONTENT_GEOMETRY_OR_SOURCE');
        await bounded(() => page.locator('#study-section').selectOption(String(result.table_section_index)), 10_000);
        // Use the critical calculation table; the programme also retains its
        // domain-budget frame before inspecting the new multilingual candidates.
        const tableMarker = material.tableMarker || null;
        await bounded(() => page.evaluate(marker => {
          const tables = [...document.querySelectorAll('#detail-body table.study-table')];
          const table = marker ? tables.find(node => node.textContent.includes(marker)) : tables[0];
          if (!table) throw new Error('Required table unavailable');
          table.scrollIntoView({ block: 'start' });
        }, tableMarker), 10_000);
        await bounded(() => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 10_000);
        const before = await bounded(() => page.locator('#resource-detail').evaluate(panel => panel.scrollTop), 10_000);
        await screenshot(page, `${stage}-study.png`);
        await bounded(() => page.locator('#exercise-panel').evaluate(node => { node.scrollIntoView({ block: 'start' }); document.getElementById('answer-tools').open = true; }), 10_000);
        const practice = await bounded(() => page.evaluate(expected => {
          const panel = document.querySelector('#exercise-panel');
          return !panel.hidden && panel.getClientRects().length > 0
            && document.querySelector('#exercise-prompt').textContent === expected
            && !document.querySelector('#text-section').hidden
            && document.querySelector('#note-answer').disabled && document.querySelector('#note-answer').value === '';
        }, material.item.exercise), 10_000);
        requireTrue(practice, 'PUBLIC_INLINE_EXERCISE');
        await screenshot(page, `${stage}-practice.png`);
        await bounded(() => page.locator('#resource-detail').evaluate((node, top) => { node.scrollTop = top; }, before), 10_000);
        const restored = await bounded(() => page.evaluate(scroll => !document.querySelector('#text-section').hidden
          && Math.abs(document.querySelector('#resource-detail').scrollTop - scroll) <= 3, before), 10_000);
        requireTrue(restored, 'READING_RETURN_POSITION');
        if (material.module === 'reading') {
          const batch = JSON.parse(readFileSync('data/canon/nominations/2026-10-12-cross-tradition-breadth.json', 'utf8'));
          const sources = new Map(batch.sources.map(source => [source.source_id, source]));
          const expectedRows = batch.works.map(work => ({ title: work.title_zh,
            url: sources.get(work.source_id).url, label: sources.get(work.source_id).creator }));
          const candidate = await bounded(() => page.evaluate(expected => {
            const table = [...document.querySelectorAll('#detail-body table.study-table')]
              .find(node => node.textContent.includes(expected[0].title));
            const rows = [...(table?.querySelectorAll('tbody tr') || [])];
            if (rows.length !== expected.length || !rows.every((row, index) => {
              const source = expected[index], cell = row.children[2]?.querySelector('.cell-value');
              const links = [...(cell?.querySelectorAll('a[href]') || [])];
              return row.textContent.includes(source.title) && links.length === 1
                && links[0].href === new URL(source.url).href && links[0].textContent.startsWith(source.label)
                && !cell.textContent.includes(source.url);
            })) return false;
            table.scrollIntoView({ block: 'start' });
            return true;
          }, expectedRows), 10_000);
          requireTrue(candidate, 'NEW_NOMINATION_TABLE_OR_COMPACT_SOURCE_LINKS');
          await bounded(() => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 10_000);
          await screenshot(page, `${stage}-nomination-study.png`);
        } else {
          const lastHeading = material.headings.at(-1);
          const value = await bounded(() => page.locator('#study-section').evaluate((select, title) => [...select.options]
            .find(option => option.textContent.replace(/^\d+\.\s*/, '') === title)?.value, lastHeading), 10_000);
          requireTrue(typeof value === 'string', 'LAST_REASONING_SECTION');
          await bounded(() => page.locator('#study-section').selectOption(value), 10_000);
          await bounded(() => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 10_000);
          const landing = await bounded(() => page.evaluate(wanted => {
            const panel = document.querySelector('#resource-detail');
            const select = document.querySelector('#study-section');
            const toolbar = document.querySelector('.detail-navigation');
            const heading = document.getElementById(`study-heading-${wanted}`);
            const rect = panel.getBoundingClientRect(), title = heading.getBoundingClientRect();
            const toolbarEnd = toolbar.getBoundingClientRect().bottom;
            const visible = title.top >= toolbarEnd && title.bottom <= rect.bottom;
            const clamped = Math.abs(panel.scrollHeight - panel.clientHeight - panel.scrollTop) <= 3;
            const current = Number(select.value), requested = Number(wanted);
            const headings = [...document.querySelectorAll('#detail-body .study-part h3')];
            const band = node => Math.max(toolbarEnd + 24,
              rect.top + panel.clientTop + (Number.parseFloat(getComputedStyle(node).scrollMarginTop) || 0) + 2);
            const currentHeading = document.getElementById(`study-heading-${current}`);
            const matchesVisibleBand = Boolean(currentHeading) && current <= requested
              && currentHeading.getBoundingClientRect().top <= band(currentHeading)
              && headings.slice(current + 1, requested + 1).every(node => node.getBoundingClientRect().top > band(node));
            return { selected: select.value, requested: wanted, heading_visible: visible,
              bottom_clamped: clamped, matches_visible_band: matchesVisibleBand,
              accepted: visible && (select.value === wanted || (clamped && matchesVisibleBand)) };
          }, value), 10_000);
          result.reasoning_anchor = landing;
          await screenshot(page, `${stage}-reasoning-study.png`);
          // A short ending may hit the scroll limit: orientation still follows
          // the visible reading band, while the requested heading stays readable.
          requireTrue(landing.accepted, 'JUMPED_SECTION_ORIENTATION');
        }
        await bounded(() => page.locator('#study-section').selectOption('extensions'), 10_000);
        await bounded(() => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 10_000);
        await screenshot(page, `${stage}-sources.png`);
        requireTrue(report.blocked_requests === 0 && report.console_errors === 0 && report.page_errors === 0, 'UNEXPECTED_REQUEST_OR_BROWSER_ERROR');
        record(stage, { url, ...result, exercise_tab: true, reading_position_restored: true, private_state_captured: false });
      }
      if (['desktop-light', 'mobile-dark'].includes(view.name)) {
        for (const { entry, payload } of expansionPayloads) {
          stage = `${view.name}-expansion-${entry.resource_id}`;
          const item = catalogs[entry.module].find(x => x.id === entry.resource_id);
          const response = await bounded(() => page.goto(`${PAGES}${entry.module}/?read=public&resource=${item.id}`,
            { waitUntil: 'domcontentloaded', timeout: remaining(30_000) }));
          requireTrue(response?.status() === 200, 'EXPANSION_ROUTE');
          await ready(page, item);
          const visible = await bounded(() => page.evaluate(content => {
            const body = document.querySelector('#detail-body');
            const normalize = value => String(value).normalize('NFKC').replace(/\s+/g, '');
            const text = normalize(body.textContent);
            const cells = [...body.querySelectorAll('td .cell-value, th')].map(x => normalize(x.textContent));
            const complete = content.sections.every(s => text.includes(normalize(s.title))
              && s.body.split('\n\n').filter(p => !p.startsWith('|')).every(p => text.includes(normalize(p)))
              && s.body.split('\n').filter(line => line.startsWith('|') && !/^\|[\s:|\-]+\|$/.test(line))
                .every(line => line.split('|').slice(1, -1).every(cell => cells.includes(normalize(cell)))));
            const tables = [...body.querySelectorAll('table.study-table')];
            const fits = tables.length > 0 && tables.every(t => t.scrollWidth <= t.clientWidth + 2)
              && document.documentElement.scrollWidth <= innerWidth + 1;
            tables[0]?.scrollIntoView({ block: 'center' });
            const hrefs = new Set([...body.querySelectorAll('a[href]')].map(link => link.href));
            const source_links_complete = content.expected_source_urls.every(url => hrefs.has(new URL(url).href));
            return { complete, fits, tables: tables.length, source_links_complete };
          }, { ...payload, expected_source_urls: expansionSources.filter(s => payload.source_ids.includes(s.source_id)).map(s => s.url) }), 10_000);
          await screenshot(page, `${stage}-study.png`);
          if (!visible.complete || !visible.fits || !visible.source_links_complete) report.expansion_failure = { stage, ...visible };
          requireTrue(visible.complete && visible.fits && visible.source_links_complete, 'EXPANSION_CONTINUOUS_TEXT_TABLE_OR_LINK');
          record(stage, { module: entry.module, id: item.id, ...visible, private_state_captured: false });
        }
      }
      if (['desktop-light', 'mobile-dark'].includes(view.name)) {
        for (const { entry, payload, item } of continuations) {
          stage = `${view.name}-continuation-${item.id}`;
          const paragraphs = payload.sections.flatMap(section =>
            section.paragraphs.map(continuationParagraphExpectation));
          const response = await bounded(() => page.goto(`${PAGES}${entry.module}/?read=public&resource=${item.id}`,
            { waitUntil: 'domcontentloaded', timeout: remaining(30_000) }));
          requireTrue(response?.status() === 200, 'CONTINUATION_ROUTE');
          await ready(page, item);
          if (item.kind === 'book') await bounded(() => page.waitForFunction(() =>
            document.querySelector('#book-study')?.shadowRoot?.querySelector('#foundation-continuation-0'),
          null, { timeout: remaining(30_000) }));
          if (item.kind === 'book') await bounded(() => page.waitForFunction(() => {
            const links = [...document.querySelector('#book-study').shadowRoot.querySelectorAll('link[rel="stylesheet"]')];
            return links.length === 2 && links.every(link => link.sheet);
          }, null, { timeout: remaining(10_000) }));
          await bounded(() => page.evaluate(() => document.fonts.ready.then(() => true)), 10_000);
          const firstTitle = payload.sections[0].title;
          const option = await bounded(() => page.waitForFunction(studyOptionForTitle, firstTitle,
            { timeout: remaining(30_000) }));
          const selected = await bounded(() => option.jsonValue());
          await bounded(() => option.dispose(), 10_000);
          requireTrue(typeof selected === 'string', 'CONTINUATION_INITIAL_CHAPTER');
          await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
          await bounded(() => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 10_000);
          try { await bounded(() => page.waitForFunction(isBook => {
            const body = isBook ? document.querySelector('#book-study').shadowRoot
              : document.querySelector('#detail-body');
            const node = body.querySelector(isBook ? '#foundation-continuation-0 h2' : '.study-part h3');
            const heading = node?.getBoundingClientRect();
            const panel = document.querySelector('#resource-detail').getBoundingClientRect();
            const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
            return Boolean(heading) && heading.top >= Math.max(panel.top, toolbar.bottom) - 2
              && heading.bottom <= panel.bottom;
          }, item.kind === 'book', { timeout: remaining(10_000) }));
          } catch {
            report.continuation_failure = { stage, geometry: await bounded(() => page.evaluate(isBook => {
              const body = isBook ? document.querySelector('#book-study').shadowRoot : document.querySelector('#detail-body');
              const heading = body.querySelector(isBook ? '#foundation-continuation-0 h2' : '.study-part h3');
              const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
              return { heading: heading && rect(heading), panel: rect(document.querySelector('#resource-detail')),
                toolbar: rect(document.querySelector('.detail-navigation')), viewport_height: innerHeight };
            }, item.kind === 'book'), 10_000) };
            await screenshot(page, `${stage}-unsettled-study.png`);
            throw new ContentFailure('CONTINUATION_INITIAL_HEADING_NOT_SETTLED');
          }
          const visible = await bounded(() => page.evaluate(({ content, isBook, paragraphs }) => {
            const body = isBook ? document.querySelector('#book-study').shadowRoot.querySelector('.book-study-content')
              : document.querySelector('#detail-body');
            const normalize = value => String(value).normalize('NFKC').replace(/\s+/g, '');
            const text = normalize(body.textContent), sections = content.sections;
            const all_paragraphs = sections.every(section => text.includes(normalize(section.title)))
              && paragraphs.every(paragraph => text.includes(normalize(paragraph.text)));
            const missing_paragraphs = paragraphs.flatMap((paragraph, index) =>
              text.includes(normalize(paragraph.text)) ? [] : [{ index, expected: paragraph.text.slice(0, 160) }]);
            const normalizeCode = value => String(value).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
            const expectedCode = paragraphs.filter(paragraph => paragraph.code !== null)
              .map(paragraph => normalizeCode(paragraph.code));
            const renderedCode = [...body.querySelectorAll('pre')].map(node => normalizeCode(node.textContent));
            const all_code_blocks = expectedCode.every(code =>
              renderedCode.filter(rendered => rendered === code).length
                >= expectedCode.filter(expected => expected === code).length);
            const all_tables = sections.every(section => !section.table || section.table.rows.every(row =>
              row.every(cell => text.includes(normalize(cell)))));
            const links = new Set([...body.querySelectorAll('a[href]')].map(a => a.href));
            const sources = content.witnesses.every(w => links.has(new URL(w.url).href));
            const blocks = isBook ? [...body.querySelectorAll('[id^="foundation-continuation-"]')]
              : [...body.querySelectorAll('.study-part')].filter(node => sections.some(s => node.textContent.includes(s.title)));
            const continuous = blocks.length >= sections.length && blocks.every(node => node.getClientRects().length
              && !node.closest('[hidden]'));
            const fits = document.documentElement.scrollWidth <= innerWidth + 1
              && [...blocks.flatMap(node => [...node.querySelectorAll('table, [role="table"]')])]
                .every(table => table.scrollWidth <= table.clientWidth + 2);
            const panel = document.querySelector('#resource-detail').getBoundingClientRect();
            const heading = blocks[0]?.querySelector('h2, h3')?.getBoundingClientRect();
            const initial_heading_in_view = Boolean(heading) && heading.top >= Math.max(panel.top, document.querySelector('.detail-navigation').getBoundingClientRect().bottom) - 2 && heading.bottom <= panel.bottom;
            return { all_paragraphs, all_code_blocks, all_tables, sources, continuous, fits, initial_heading_in_view,
              missing_paragraphs,
              initial_geometry: { heading_top: heading?.top, heading_bottom: heading?.bottom,
                panel_top: panel.top, panel_bottom: panel.bottom,
                toolbar_bottom: document.querySelector('.detail-navigation').getBoundingClientRect().bottom },
              sections: sections.length };
          }, { content: payload, isBook: item.kind === 'book', paragraphs }), 10_000);
          await screenshot(page, `${stage}-study.png`);
          if (!Object.entries(visible).filter(([key]) => key !== 'sections').every(([,v]) => v))
            report.continuation_failure = { stage, ...visible };
          requireTrue(visible.all_paragraphs && visible.all_code_blocks && visible.all_tables && visible.sources && visible.continuous && visible.fits && visible.initial_heading_in_view,
            'CONTINUATION_VISIBLE_TEXT_TABLE_OR_SOURCE');
          record(stage, { module: entry.module, id: item.id, ...visible, private_state_captured: false });
          const firstCode = paragraphs.find(paragraph => paragraph.code !== null)?.code;
          if (firstCode !== undefined) {
            const found = await bounded(() => page.evaluate(({ isBook, code }) => {
              const body = isBook ? document.querySelector('#book-study').shadowRoot : document.querySelector('#detail-body');
              const normalize = value => value.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
              const block = [...body.querySelectorAll('pre')].find(node => normalize(node.textContent) === normalize(code));
              block?.scrollIntoView({ block: 'center' });
              return Boolean(block);
            }, { isBook: item.kind === 'book', code: firstCode }), 10_000);
            requireTrue(found, 'CONTINUATION_CODE_SCREENSHOT_TARGET');
            await screenshot(page, `${stage}-code.png`);
          }
          if (item.id === 'd04-v33-u1' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-good-trace', 'worked-source-not-entailment']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 4, 'AGENT_LOOP_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'AGENT_LOOP_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'AGENT_LOOP_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'd04-v33-u3' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-full-ledger', 'worked-answer-matrix']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 4, 'MEMORY_CHAIN_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'MEMORY_CHAIN_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'MEMORY_CHAIN_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'd04-v33-u4' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-crash-windows', 'worked-reference-answers']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 4, 'PERSISTENCE_CHAIN_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'PERSISTENCE_CHAIN_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'PERSISTENCE_CHAIN_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'd04-v33-u5' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-export-contract', 'worked-reference-answers']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 4, 'COMPUTER_COLLABORATION_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'COMPUTER_COLLABORATION_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'COMPUTER_COLLABORATION_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              const lastRow = figure.locator('tbody tr').last();
              await bounded(() => lastRow.evaluate(node => node.scrollIntoView({ block: 'center' })), 10_000);
              await bounded(() => page.waitForFunction(selector => {
                const rows = document.querySelectorAll(`${selector} tbody tr`);
                const row = rows[rows.length - 1]?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
              }, `#study-part-${selected} .study-table`, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-table-end-study.png`);
              record(stage, { last_row_visible: true, section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'data_sources' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-twelve-cutoffs', 'worked-backfill-order']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 3, 'TRADING_VINTAGE_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'TRADING_VINTAGE_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'TRADING_VINTAGE_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'd04-v33-u2' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-two-observations', 'worked-repetition-budget', 'worked-proposal-budget']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 4, 'AGENT_TOOLS_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'AGENT_TOOLS_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'AGENT_TOOLS_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'd08-v33-u1' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-all-workspace-cases', 'worked-origin-continuum', 'worked-near-singular-speeds', 'worked-points-and-vectors']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 3, 'ROBOT_KINEMATICS_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'ROBOT_KINEMATICS_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'ROBOT_KINEMATICS_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'risk_policy' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-three-repairs', 'worked-capacity-profiles', 'worked-account-cash-bridge', 'worked-consolidated-cash-bridge']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 3, 'TRADING_RISK_LEDGER_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'TRADING_RISK_LEDGER_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'TRADING_RISK_LEDGER_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'strategy_registry' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-selection-20', 'worked-audit-counts', 'worked-unknown-resolution', 'worked-stage-gates']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 3, 'TRADING_STRATEGY_REGISTRY_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'TRADING_STRATEGY_REGISTRY_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'TRADING_STRATEGY_REGISTRY_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              if (['worked-selection-20', 'worked-audit-counts'].includes(unit)) {
                const rows = figure.locator('tbody tr');
                requireTrue(await rows.count() === payload.sections[index].table.rows.length,
                  'TRADING_STRATEGY_REGISTRY_TABLE_ROW_COUNT');
                await bounded(() => rows.last().scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (item.id === 'plato-republic' && ['1.1.0', '1.1.1'].includes(payload.version)) {
            const baseStage = stage;
            for (const unit of ['power-and-craft', 'justice-without-reputation']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 0, 'REPUBLIC_REASONING_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'REPUBLIC_REASONING_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(index => {
                const root = document.querySelector('#book-study').shadowRoot;
                const heading = root.querySelector(`#foundation-continuation-${index} h2`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, index, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator('#book-study').locator(`#foundation-continuation-${index} .knowledge-visual`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'REPUBLIC_REASONING_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'harvey-circulation-reading' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-historical-units', 'worked-bound-and-input', 'worked-distinct-parcels', 'worked-inflow-outflow']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 18, 'HARVEY_EVIDENCE_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'HARVEY_EVIDENCE_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'HARVEY_EVIDENCE_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'd06-v33-u1' && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of ['worked-inputs', 'worked-confusion', 'worked-thresholds', 'worked-costs', 'worked-denominators', 'worked-waiting-time']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 1, 'METRICS_BASELINE_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'METRICS_BASELINE_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'METRICS_BASELINE_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'METRICS_BASELINE_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (item.id === 'd06-v33-u2' && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of ['worked-machine-pairs', 'worked-order', 'worked-allocations', 'worked-ties', 'worked-paired-allocations', 'worked-selection', 'worked-stopping']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 1, 'EXPERIMENT_DESIGN_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'EXPERIMENT_DESIGN_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'EXPERIMENT_DESIGN_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'EXPERIMENT_DESIGN_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (item.id === 'd06-v33-u3' && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of ['worked-original-exercise', 'worked-late-arrival', 'worked-atomic-gap', 'worked-restart', 'worked-deleted-card', 'worked-stop', 'worked-retry-tree', 'worked-deadline', 'worked-late-success']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 1, 'FAULT_STATE_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'FAULT_STATE_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'FAULT_STATE_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'FAULT_STATE_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (item.id === 'd07-v33-u1' && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of ['worked-original-exercise', 'worked-folds', 'worked-refit', 'worked-known-groups', 'worked-new-groups', 'worked-clocks', 'worked-fit-clock', 'worked-evaluation-clock', 'worked-selection', 'worked-tie-rule']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 1, 'DATASET_SPLIT_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'DATASET_SPLIT_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'DATASET_SPLIT_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'DATASET_SPLIT_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (item.id === 'd07-v33-u2' && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of ['worked-original-exercise', 'worked-learning-rate', 'worked-trainable', 'worked-accumulation', 'worked-unequal-batches', 'worked-mask', 'worked-momentum', 'worked-resume', 'worked-cursor', 'worked-low-rank-step', 'worked-low-rank-boundaries', 'worked-parameter-count']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 1, 'TRAINING_UPDATE_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'TRAINING_UPDATE_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'TRAINING_UPDATE_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'TRAINING_UPDATE_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (item.id === 'd07-v33-u3' && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of ['worked-original-exercise', 'worked-intensity', 'worked-parallel', 'worked-communication', 'worked-single-queue', 'worked-full-batch', 'worked-capacity-window', 'worked-original-wait', 'worked-formation-delay', 'worked-no-formation-wait', 'worked-metric-clocks', 'worked-stream-timeline', 'worked-chunks', 'worked-empty-response', 'worked-partial']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 1, 'INFERENCE_CLOCKS_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'INFERENCE_CLOCKS_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'INFERENCE_CLOCKS_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'INFERENCE_CLOCKS_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (item.id === 'd03-v33-u6' && ['1.0.0', '1.0.1'].includes(payload.version)) {
            const baseStage = stage;
            for (const unit of ['worked-score-matrix', 'worked-two-directions', 'worked-ties', 'worked-pair-identity', 'worked-rejection', 'worked-training-stages', 'worked-demonstrations', 'worked-vote-weights', 'worked-preference-truth', 'worked-reference-examples', 'worked-eight-task-hours', 'worked-task-responsibility', 'worked-original-demand', 'worked-adoption-review', 'worked-capability-scope']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 1, 'MULTIMODAL_PREFERENCE_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'MULTIMODAL_PREFERENCE_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'MULTIMODAL_PREFERENCE_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'MULTIMODAL_PREFERENCE_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (['d09-v33-u1', 'd09-v33-u2', 'd09-v33-u4'].includes(item.id) && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of {"d09-v33-u1": ["worked-claim-card", "worked-source-role", "worked-lineage", "worked-two-roots", "worked-rates", "worked-correction", "worked-missing", "worked-measurement", "worked-absence", "worked-counterexplanations"], "d09-v33-u2": ["worked-original-cells", "worked-crude-within", "worked-target-mix", "worked-heterogeneity", "worked-assignment-adoption", "worked-units", "worked-outcome-window", "worked-predeclared-plan", "worked-recomputation"], "d09-v33-u4": ["worked-six-lines", "worked-concomitant-change", "worked-leave-one-out", "worked-conditional-interval", "worked-three-boundaries", "worked-strongest-objection", "worked-answered-memo", "worked-next-verification", "worked-reanalysis-new-study", "worked-revision-log"]}[item.id]) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 1, 'RESEARCH_METHODS_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'RESEARCH_METHODS_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'RESEARCH_METHODS_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'RESEARCH_METHODS_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (['d11-v33-u1', 'd11-v33-u2', 'd11-v33-u3', 'd11-v33-u4', 'd11-v33-u5'].includes(item.id) && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of {"d11-v33-u1": ["worked-complete-plans", "worked-half-hour", "worked-feasibility", "worked-ties-and-choice", "worked-marginal", "worked-recoverable", "worked-demand", "worked-supply", "worked-market-table", "worked-intersection", "worked-demand-shift", "worked-supply-shift", "worked-tax-wedge", "worked-model-domain", "worked-claims-ledger"], "d11-v33-u2": ["worked-question", "worked-two-questions", "worked-write-down", "worked-sale75", "worked-sale40", "worked-thresholds", "worked-calendar75", "worked-calendar40", "worked-collection-risk", "worked-liquidation"], "d11-v33-u3": ["worked-question", "worked-sequence", "worked-profit", "worked-balance-sheet", "worked-direct-cash", "worked-indirect-cash", "worked-impairment", "worked-gross-net", "worked-collection", "worked-collect-impair", "worked-boundaries", "worked-free-cash"], "d11-v33-u4": ["worked-question", "worked-leverage", "worked-linear-contract", "worked-margin-contract", "worked-margin-shortfall", "worked-margin-funded", "worked-call-contract", "worked-call-table", "worked-break-even", "worked-premium-change", "worked-physical-funding", "worked-path-versus-terminal"], "d11-v33-u5": ["worked-question", "worked-rebalance-question", "worked-self-financing", "worked-periods", "worked-correlation", "worked-compound", "worked-expectation", "worked-drawdown", "worked-floor", "worked-cost-base", "worked-cost-scale", "worked-research-split", "worked-time-budget"]}[item.id]) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 0, 'FINANCE_FOUNDATIONS_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'FINANCE_FOUNDATIONS_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'FINANCE_FOUNDATIONS_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'FINANCE_FOUNDATIONS_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (['ai-automation-payback', 'ai-capacity-commitment', 'ai-capital-cycle', 'ai-inference-economics'].includes(item.id) && (payload.version === '1.0.0' || (item.id === 'ai-capital-cycle' && payload.version === '1.0.1'))) {
            const baseStage = stage;
            for (const unit of {"ai-automation-payback": ["worked-question", "worked-hours", "worked-routes", "worked-payroll", "worked-project-capacity", "worked-demand", "worked-isolated-stresses", "worked-adoption-mechanism", "worked-payback-definition", "worked-cash-terms", "worked-high-calendar", "worked-low-calendar", "worked-startup-order", "worked-survey-boundary"], "ai-capacity-commitment": ["worked-question", "worked-contract", "worked-normal-month", "worked-credit", "worked-whole-unit-threshold", "worked-demand-and-boundary", "worked-queue-units", "worked-conditions", "worked-equal-means", "worked-sla-meaning", "worked-cash-calendar", "worked-no-bridge", "worked-explicit-bridge", "worked-credit-funding", "worked-low-demand-loan", "worked-reconciliation"], "ai-capital-cycle": ["worked-question", "worked-year-givens", "worked-cash-sequence", "worked-income", "worked-profit-cash-bridge", "worked-balance-sheet", "worked-negative-cash-shorthand", "worked-original-eps", "worked-new-dates", "worked-weighted-shares", "worked-price-versus-business", "worked-new-impairment", "worked-project-boundary", "worked-five-cashflows", "worked-annuity-threshold", "worked-evidence-chain"], "ai-inference-economics": ["worked-question", "worked-physical-givens", "worked-token-conversion", "worked-billing", "worked-original-power", "worked-month-income", "worked-new-ledger", "worked-ledger-balance", "worked-utilization-break-even", "worked-price-compression", "worked-new-billable", "worked-new-idle-power", "worked-zero-and-full", "worked-project-clock", "worked-geometric-discount", "worked-all-month-cash", "worked-project-boundaries"]}[item.id]) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 0, 'AI_ECONOMICS_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'AI_ECONOMICS_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'AI_ECONOMICS_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'AI_ECONOMICS_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (['earnings-cashflow', 'funding-deadline', 'operational-reconciliation'].includes(item.id) && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of {"earnings-cashflow": ["worked-question", "worked-givens", "worked-cash-order", "worked-income", "worked-balance", "worked-cash-bridge", "worked-capex-shorthand", "worked-original-multiple", "worked-allowance", "worked-gross-net", "worked-zero-negative", "worked-new-collection", "worked-collection-allowance", "worked-price-input", "worked-evidence-choice"], "funding-deadline": ["worked-question", "worked-givens", "worked-purchase", "worked-liquidity", "worked-bridge-deadline", "worked-bridge-sale", "worked-forced98", "worked-forced60", "worked-two-thresholds", "worked-extension", "worked-unsettled", "worked-later-profit", "worked-evidence"], "operational-reconciliation": ["worked-question", "worked-givens", "worked-split", "worked-first-fill", "worked-duplicate", "worked-second-fill", "worked-cancel-reject", "worked-dated-settlement", "worked-confirmed-cash", "worked-old-cutoff", "worked-cash-unexplained", "worked-fee-voucher", "worked-counterfactual-paths", "worked-stop-boundaries"]}[item.id]) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 0, 'CASH_LEDGER_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'CASH_LEDGER_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'CASH_LEDGER_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'CASH_LEDGER_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (['leverage-margin', 'order-execution', 'execution-benchmark'].includes(item.id) && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of {"leverage-margin": ["worked-question", "worked-givens", "worked-opening-cash", "worked-denominators", "worked-five-marks", "worked-equality", "worked-changing-leverage", "worked-zero-equity", "worked-mark-fill", "worked-closeout85", "worked-closeout70", "worked-payment-clock", "worked-lower-debt", "worked-new-owner-cash", "worked-retained-cash", "worked-paydown", "worked-evidence"], "order-execution": ["worked-question", "worked-givens", "worked-order-states", "worked-market-fills", "worked-fee", "worked-ioc-fills", "worked-weighted-average", "worked-intent-denominator", "worked-terminal-up", "worked-terminal-down", "worked-limit-exercise", "worked-no-fill", "worked-one-level", "worked-fee-and-reference", "worked-evidence"], "execution-benchmark": ["worked-question", "worked-givens", "worked-separate-case", "worked-quoted-spread", "worked-effective-spreads", "worked-effective-weighting", "worked-one-way-cash", "worked-realized-spreads", "worked-realized-weighting", "worked-price-change", "worked-new-horizon", "worked-full-intent", "worked-delay-decomposition", "worked-units", "worked-decision-exercise", "worked-new-terminal", "worked-no-executions", "worked-sell-direction"]}[item.id]) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 0, 'EXECUTION_LEDGER_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'EXECUTION_LEDGER_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'EXECUTION_LEDGER_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'EXECUTION_LEDGER_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (['option-payoff', 'point-in-time-thesis', 'portfolio-rebalancing', 'svb-2023-liquidity'].includes(item.id) && payload.version === '1.0.0') {
            const baseStage = stage;
            for (const unit of {"option-payoff": ["worked-question", "worked-contract", "worked-opening", "worked-intrinsic", "worked-cash-layers", "worked-call-table", "worked-put-table", "worked-breakeven", "worked-small-payoff", "worked-funding-boundary", "worked-preexpiry-quote", "worked-new-quote", "worked-exclusive-exits", "worked-multiplier10", "worked-fixed-cost-per-unit"], "point-in-time-thesis": ["worked-question", "worked-clocks", "worked-evidence-layers", "worked-historical-bridge", "worked-market-value", "worked-cash-adjustments", "worked-competing-arguments", "worked-forecast-periods", "worked-terminal-clock", "worked-three-scenarios", "worked-terminal-dependence", "worked-display-ratios", "worked-policy-first", "worked-loss-budget", "worked-two-windows", "worked-new-review-memos"], "portfolio-rebalancing": ["worked-question", "worked-opening", "worked-hard-gates", "worked-sale-receivable", "worked-no-same-day-spending", "worked-buyb-ledger", "worked-turnover-and-nav", "worked-given-correlations", "worked-matrix-validity", "worked-risk-denominator", "worked-stress-additions", "worked-four-profiles", "worked-sell-only-ledger", "worked-floor25000", "worked-original-breaches"], "svb-2023-liquidity": ["worked-question", "worked-source-clocks", "worked-reported-ledger", "worked-original-verbs", "worked-wrong-sums", "worked-sale-loss", "worked-financing-stages", "worked-cash-bridge", "worked-value-and-payment", "worked-rival-mechanisms", "worked-report-viewpoint", "worked-lombard-connection"]}[item.id]) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 0, 'DECISION_CHAIN_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'DECISION_CHAIN_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'DECISION_CHAIN_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              requireTrue(await figure.locator('tbody tr').count() === payload.sections[index].table.rows.length,
                'DECISION_CHAIN_TABLE_ROW_COUNT');
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
              {
                const last = figure.locator('tbody tr').last();
                await bounded(() => last.scrollIntoViewIfNeeded(), 10_000);
                await bounded(() => page.waitForFunction(value => {
                  const row = document.querySelector(`#study-part-${value} .study-table tbody tr:last-child`)?.getBoundingClientRect();
                  const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                  const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                  return row && row.top >= Math.max(panel.top, toolbar.bottom) - 2 && row.bottom <= panel.bottom;
                }, selected, { timeout: remaining(10_000) }));
                await screenshot(page, `${stage}-last-row-study.png`);
                record(`${stage}-last-row`, { section_id: unit, last_row_visible: true, private_state_captured: false });
              }
            }
            stage = baseStage;
          }
          if (item.id === 'd08-v33-u3' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-state-observation', 'worked-td-update-order', 'worked-ppo-no-hard-bound', 'worked-entropy-objective']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 4, 'RL_FOUNDATIONS_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'RL_FOUNDATIONS_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'RL_FOUNDATIONS_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'universe_design' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-two-clocks', 'worked-eligibility-data', 'worked-freshness-units', 'worked-wrong-views']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 3, 'TRADING_UNIVERSE_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'TRADING_UNIVERSE_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'TRADING_UNIVERSE_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'd08-v33-u2' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-forward-inverse-table', 'worked-pd-roots', 'worked-euler-boundaries', 'worked-time-step-comparison']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 3, 'ROBOT_DYNAMICS_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'ROBOT_DYNAMICS_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'ROBOT_DYNAMICS_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'mill-liberty-reading' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-opinion-reasons', 'worked-bridge-information', 'worked-interested-advice', 'worked-indirect-restrictions']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 5, 'MILL_BOUNDARIES_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              requireTrue(/^\d+$/.test(selected), 'MILL_BOUNDARIES_WORKED_NAVIGATION');
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(value => {
                const heading = document.querySelector(`#study-heading-${value}`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, selected, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator(`#study-part-${selected} .study-table`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'MILL_BOUNDARIES_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'abelson-sussman-sicp' && payload.schema_version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-eval-apply', 'worked-captured-state', 'worked-thunk-environment', 'worked-memoization-effects']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 22, 'SICP_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(index => {
                const root = document.querySelector('#book-study').shadowRoot;
                const heading = root.querySelector(`#foundation-continuation-${index} h2`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, index, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator('#book-study').locator(`#foundation-continuation-${index} .knowledge-visual`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'SICP_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'charles-darwin-origin-of-species' && payload.schema_version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-dispersal-chain', 'worked-drying-preparation', 'worked-two-proportions', 'worked-mud-and-carriers']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 17, 'DARWIN_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(index => {
                const root = document.querySelector('#book-study').shadowRoot;
                const heading = root.querySelector(`#foundation-continuation-${index} h2`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, index, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator('#book-study').locator(`#foundation-continuation-${index} .knowledge-visual`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'DARWIN_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'rene-descartes-discourse-method' && payload.version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-history-selection', 'worked-particular-causes', 'worked-causes-effects', 'worked-instrument-failure']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 6, 'DESCARTES_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(index => {
                const root = document.querySelector('#book-study').shadowRoot;
                const heading = root.querySelector(`#foundation-continuation-${index} h2`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, index, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator('#book-study').locator(`#foundation-continuation-${index} .knowledge-visual`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'DESCARTES_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'john-snow-mode-communication-cholera' && payload.schema_version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-weekly-source-missingness', 'worked-allocation-assumptions', 'worked-conditional-rate-bounds']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 13, 'SNOW_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(index => {
                const root = document.querySelector('#book-study').shadowRoot;
                const heading = root.querySelector(`#foundation-continuation-${index} h2`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, index, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator('#book-study').locator(`#foundation-continuation-${index} .knowledge-visual`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'SNOW_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
          if (item.id === 'adam-smith-wealth-of-nations' && payload.schema_version === '1.1.0') {
            const baseStage = stage;
            for (const unit of ['worked-paper-metal-positions', 'worked-released-resource-routes', 'worked-redemption-is-a-cash-question']) {
              const index = payload.sections.findIndex(section => section.unit_id === unit);
              requireTrue(index >= 17, 'SMITH_WORKED_CASE_IDENTITY');
              stage = `${baseStage}-${unit}`;
              const option = await bounded(() => page.waitForFunction(studyOptionForTitle, payload.sections[index].title,
                { timeout: remaining(10_000) }));
              const selected = await bounded(() => option.jsonValue());
              await bounded(() => option.dispose(), 10_000);
              await bounded(() => page.locator('#study-section').selectOption(selected), 10_000);
              await bounded(() => page.waitForFunction(index => {
                const root = document.querySelector('#book-study').shadowRoot;
                const heading = root.querySelector(`#foundation-continuation-${index} h2`)?.getBoundingClientRect();
                const panel = document.querySelector('#resource-detail').getBoundingClientRect();
                const toolbar = document.querySelector('.detail-navigation').getBoundingClientRect();
                return heading && heading.top >= Math.max(panel.top, toolbar.bottom) - 2 && heading.bottom <= panel.bottom;
              }, index, { timeout: remaining(10_000) }));
              await screenshot(page, `${stage}-study.png`);
              const figure = page.locator('#book-study').locator(`#foundation-continuation-${index} .knowledge-visual`);
              requireTrue(await figure.count() === 1 && await figure.evaluate(node => node.scrollWidth <= node.clientWidth + 2),
                'SMITH_WORKED_CASE_TABLE');
              const filename = `${stage}-table-study.png`;
              await bounded(() => figure.screenshot({ path: `${OUTPUT}/${filename}`, animations: 'disabled' }));
              report.screenshots.push(filename);
              record(stage, { section_id: unit, heading_visible: true, table_visible: true, private_state_captured: false });
            }
            stage = baseStage;
          }
        }
      }
      await bounded(() => context.close(), 10_000);
        viewportRun.status = 'PASS';
      } catch (error) {
        viewportRun.status = 'FAIL';
        viewportRun.failed_stage = stage;
        if (error instanceof Error) error.contentStage = stage;
        throw error;
      }
    });
    requireTrue(report.viewport_runs.length === VIEWS.length
      && new Set(report.viewport_runs.map(view => view.name)).size === VIEWS.length
      && report.viewport_runs.every(view => view.status === 'PASS'), 'ALL_VIEWPORTS_COMPLETED');
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failed_stage = error?.contentStage || stage;
    report.failure = error instanceof ContentFailure ? error.message : 'UNEXPECTED_OPERATION_FAILURE';
  } finally {
    if (browser) {
      let timer;
      try { await Promise.race([browser.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 15_000); })]); }
      finally { clearTimeout(timer); }
    }
    report.finished = new Date().toISOString(); report.elapsed_seconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(`${OUTPUT}/report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${report.status}\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAcceptance();
  console.log(`Public content acceptance ${result.status}; checks=${result.checks.length}; report=${OUTPUT}/report.json`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
