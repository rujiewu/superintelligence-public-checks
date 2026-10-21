// Real Pages browser geometry with synthetic record responses; never a live model/state flow.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { publicBytes } from './public-qa-fetch.mjs';
import { hosting } from './hosting-config.mjs';
import { capsule, capsuleRunnerAllowed } from './public-capsule.mjs';

const PAGES = hosting.pages_url;
const API = hosting.api_origin;
const BASE = hosting.site_base;
const OUTPUT = 'test-results/public-content';
const STATIC = 'dist/ui-preview/assets';
const PREVIEW = 'dist/ui-preview';
const overlay = process.env.UI_SOURCE_OVERLAY === 'true';
const sessionId = 'a'.repeat(32);
const targets = [
  { module: 'reading', id: 'abelson-sussman-sicp' },
  { module: 'learning', id: 'd02-v33-u6' },
  { module: 'trading', id: 'operational-reconciliation' },
  { module: 'investment', id: 'investment-workspace' },
];
const views = [
  { name: 'desktop-light', width: 1440, height: 1000, theme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 1000, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, theme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, theme: 'dark' },
  { name: 'compact-light', width: 320, height: 844, theme: 'light' },
];
const report = { status: 'RUNNING', source_commit: process.env.EXPECTED_SOURCE_SHA,
  source_overlay: overlay, url: PAGES, checks: [], screenshots: [], synthetic_api_requests: 0,
  forbidden_requests: 0, real_api_requests: 0, model_calls: 0, real_record_writes: 0, public_get_retries: [],
  expected_annotation_conflicts: 0,
  expected_annotation_expiries: 0,
  expected_console_rejections: [],
  limitations: ['Public HTTPS origin on GitHub-hosted Chromium; viewport emulation, not physical devices.',
    'Login, notes, history and navigation are synthetic responses intercepted before network access.',
    'Overlay mode previews checked-out HTML/CSS/JS on the public origin before publication.',
    'Human screenshot inspection is required; geometry checks alone do not certify visual quality.'] };
const started = Date.now(), deadline = Math.min(started + 360000,
  Number(process.env.PUBLIC_CONTENT_JOB_STARTED_MS || started) + 780000);
const digest = data => createHash('sha256').update(data).digest('hex');
const semantic = (title, summary, key = title, model = 'gpt-6.1-sol') => ({ status: 'COMPLETED', model,
  reported_model: model,
  profile: 'private-organization-v1', source_sha256: digest(key), title, summary,
  topics: [], key_points: [], open_questions: [] });
const assets = new Set(readdirSync(STATIC).filter(name => /\.(?:css|js)$/.test(name)));
mkdirSync(OUTPUT, { recursive: true, mode: 0o700 });
let browser, stage = 'runner', errors = [];
let readingItems, learningItems;
const record = name => report.checks.push({ name, status: 'PASS' });
const nextFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function publicFile(path) {
  if (overlay && path.startsWith('data/')) return readFileSync(PREVIEW + '/' + path);
  return publicBytes(PAGES + path, deadline, {
    onRetry: retry => report.public_get_retries.push(retry),
  });
}

async function context(view, target, connected = true, chat = null, noteScenario = null) {
  assert.ok(Date.now() < deadline, 'UI deadline');
  const injectedRejections = new Set();
  const deletedSessions = new Set();
  const ctx = await browser.newContext({ viewport: { width: view.width, height: view.height },
    colorScheme: view.theme, isMobile: view.width < 760, hasTouch: view.width < 760, serviceWorkers: 'block' });
  await ctx.addInitScript(({ api, theme, connected }) => {
    localStorage.setItem('hub-theme', theme);
    for (const module of ['reading', 'learning', 'trading', 'investment']) {
      localStorage.setItem('hub-discussion-choice-v1:' + module, JSON.stringify({ model: 'claude-opus-5-5', effort: 'low' }));
    }
    if (connected) sessionStorage.setItem('hub-shared-session:' + api, JSON.stringify({
      token: 'synthetic-ui-session', expires_at: new Date(Date.now() + 3600000).toISOString(),
    }));
  }, { api: API, theme: view.theme, connected });
  await ctx.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if ([API, hosting.api_fallback_origin].includes(url.origin)) {
      report.synthetic_api_requests++;
      let body;
      const themes = {
        reading: [['递归程序与计算过程', '区分程序的写法与实际计算展开的过程。'], ['替换模型的解释范围', '讨论替换步骤如何帮助理解程序执行。']],
        learning: [['测试与故障定位', '把可复现现象与待验证的故障假设分开。'], ['交付条件与回滚', '检查交付前提及失败后的恢复路径。']],
        trading: [['撤单与已完成成交', '区分撤销剩余指令和已经发生的成交。'], ['现金与证券的交收', '按时间核对成交记录与实际交收。']],
        investment: [['现金缓冲与约束', '把可用资金和后续支出放进同一决策记录。'], ['估值区间与条件', '保留估值假设及需要重新判断的条件。']],
      }[target.module];
      const record = { id: sessionId, module: target.module, resource_id: target.id,
        title: '模拟材料标题', sha: 'synthetic-session-v1',
        organization: semantic(...themes[0]),
        preview: { opening: '分工为什么能提高生产效率？', latest: '交换范围怎样限制分工？', message_count: 2 } };
      if (url.pathname === '/api/release' && method === 'GET' && !request.headers().authorization) {
        body = { packaged: true, source_commit: process.env.EXPECTED_SOURCE_SHA,
          chat_packet_validation: 'sha256-v1', packets_sha256: { 'data/catalog-reading.json': 'a'.repeat(64) } };
      }
      else if (url.pathname === '/api/me' && method === 'GET') {
        if (noteScenario?.delayAuth) await new Promise(resolve => { noteScenario.releaseAuth = resolve; });
        body = { authenticated: true, password_required: true };
      }
      else if (url.pathname === '/api/release' && method === 'GET' && chat) {
        chat.releaseReads = (chat.releaseReads || 0) + 1;
        body = chat.recovery && chat.posts.length ? { packaged: true,
          chat_packet_validation: 'sha256-v1', packets_sha256: {} } : chat.release;
      }
      else if (url.pathname === '/api/discussion-models') body = { version: 'discussion-models-v4',
        models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low','medium','high','xhigh','max'], default_effort: 'high' },
          { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', efforts: ['low','medium','high','xhigh'], default_effort: 'high' }],
        default_model: 'claude-opus-5-5', default_effort: 'high' };
      else if (url.pathname === '/api/login' && method === 'POST') body = { authenticated: true,
        password_required: true, token: 'synthetic-ui-session', expires_at: Math.floor(Date.now() / 1000) + 3600 };
      else if (url.pathname === '/api/preferences' && ['GET', 'PUT'].includes(method)) body = {
        last_resource_id: null, sections: target.module === 'reading' ? { [target.id]: 'book:foundation-1' } : {}, sha: 'synthetic-navigation-v1' };
      else if (url.pathname === '/api/notes' && method === 'GET') body = {
        organization: semantic('论证前提与反例', '按前提、推理与反例组织练习回答。'),
        answer: '模拟练习：先列前提，再解释推理；最后找一个反例。此文本仅用于界面检查。', sha: 'synthetic-note-v1', revisions: [] };
      else if (url.pathname === '/api/notes' && method === 'PUT') return route.fulfill({ status: 409,
        json: { detail: '模拟版本冲突：草稿仍保留。' } });
      else if (url.pathname === '/api/annotations' && method === 'GET') body = noteScenario?.record || {
        schema_version: '1.0.0', entries: [], sha: null };
      else if (url.pathname === '/api/annotations' && method === 'PUT' && noteScenario) {
        const payload = JSON.parse(request.postData());
        noteScenario.writes.push(payload);
        if (payload.comment === '模拟过期草稿') {
          report.expected_annotation_expiries++;
          injectedRejections.add(request.url() + '|401');
          return route.fulfill({ status: 401, json: { detail: '模拟会话过期。' } });
        }
        assert.equal(payload.expected_sha, noteScenario.record.sha);
        const prior = noteScenario.record.entries.find(entry => entry.id === payload.id);
        if (payload.comment === '模拟冲突草稿') {
          report.expected_annotation_conflicts++;
          injectedRejections.add(request.url() + '|409');
          prior.comment = '另一窗口的模拟修改'; prior.revision = 'f'.repeat(64);
          noteScenario.record.sha = 'synthetic-annotations-conflict';
          return route.fulfill({ status: 409, json: { detail: '模拟笔记冲突。' } });
        }
        assert.equal(payload.expected_revision, prior?.revision || null);
        const entry = { ...payload, revision: String(noteScenario.writes.length).padStart(64, '0'),
          organization: { ...semantic('解释与例子的联系', '用例子核对解释中的推理步骤。', payload.comment), status: 'PENDING' },
          revisions: [...(prior?.revisions || []), { comment: payload.comment, created_at: '2026-10-14T00:00:00Z' }] };
        noteScenario.record = { schema_version: '1.0.0', sha: 'synthetic-annotations-' + noteScenario.writes.length,
          entries: [...noteScenario.record.entries.filter(value => value.id !== entry.id), entry] };
        body = noteScenario.record;
      }
      else if (url.pathname === '/api/organization' && method === 'POST' && noteScenario) {
        const payload = JSON.parse(request.postData());
        const entry = noteScenario.record.entries.find(entry => entry.id === payload.record_id);
        assert.ok(entry);
        assert.equal(payload.source_sha256, entry.organization.source_sha256);
        noteScenario.organizationCalls = (noteScenario.organizationCalls || 0) + 1;
        entry.organization = { ...entry.organization, status: 'COMPLETED' };
        body = entry.organization;
      }
      else if (url.pathname === '/api/annotations' && method === 'DELETE' && noteScenario) {
        const payload = JSON.parse(request.postData());
        assert.equal(payload.expected_sha, noteScenario.record.sha);
        const entry = noteScenario.record.entries.find(value => value.id === payload.id);
        assert.equal(payload.expected_revision, entry.revision);
        noteScenario.deletes = (noteScenario.deletes || 0) + 1;
        noteScenario.record = { ...noteScenario.record, sha: 'synthetic-deleted-' + noteScenario.deletes,
          entries: noteScenario.record.entries.filter(value => value.id !== payload.id) };
        body = noteScenario.record;
      }
      else if (url.pathname === '/api/sessions' && method === 'GET') body = [record,
        { ...record, id: 'b'.repeat(32), organization: semantic(...themes[1], themes[1][0], 'claude-opus-5-5'), preview: { opening: '自然价格与市场价格有什么区别？',
          latest: '怎样区分暂时波动与长期变化？', message_count: 2 } }].filter(item => !deletedSessions.has(item.id));
      else if (url.pathname === '/api/sessions/' + sessionId && method === 'DELETE') {
        assert.equal(JSON.parse(request.postData()).expected_sha, record.sha);
        deletedSessions.add(sessionId);
        body = { id: sessionId, module: target.module, deleted_at: '2026-10-19T00:00:00Z', sha: 'synthetic-deleted' };
      }
      else if (url.pathname === '/api/sessions' && method === 'POST' && chat) body = record;
      else if (url.pathname === '/api/chat' && method === 'POST' && chat) {
        const payload = JSON.parse(request.postData());
        if (chat.recovery && chat.posts.length) {
          assert.equal(payload.request_id, chat.posts[0].request_id);
          assert.equal(payload.expected_packets_sha256, undefined);
        } else assert.deepEqual(payload.expected_packets_sha256, chat.expected);
        chat.posts.push(payload);
        if (chat.recovery && chat.posts.length === 1) return route.fulfill({ status: 200,
          body: '{"status":"COMPLETED"', contentType: 'application/json' });
        body = { status: 'COMPLETED', reply: '资料版本一致。这是模拟回复，用于检查提交与显示流程。',
          context_ids: [target.id], session_id: sessionId };
      }
      else if (method === 'GET' && chat?.recovery && chat.posts.length
        && url.pathname === '/api/requests/' + chat.posts[0].request_id) body = {
        id: chat.posts[0].request_id, module: target.module, session_id: sessionId,
        resource_id: target.id, message: chat.posts[0].message, status: 'COMPLETED' };
      else if (url.pathname === '/api/sessions/' + sessionId && method === 'GET') body = { ...record,
        messages: [{ role: 'user', content: '这一步的结论依赖哪些前提？（模拟提问）' },
          { role: 'assistant', content: '先看这个模拟例子。## 从问题到结论\n这是一段模拟回答，只用于检查段落、代码与表格的阅读效果。\n教学代码。```python\ntotal = 0\n# 代码内的。## 标记保持原样\n```\n逐步检查。1. 写出当前条件。2. 沿着推理核对每一步。3. 改变一个条件，观察结论是否成立。\n对照如下。| 检查 | 要问的问题 |\n| --- | --- |\n| 前提 | 哪些信息已经得到支持？ |\n| 边界 | 换个情境还成立吗？ |\n\n再想一步：另一领域出现相似结构时，哪些条件必须重新核验？' }] };
      else {
        report.forbidden_requests++;
        return route.fulfill({ status: 400, json: { detail: 'UI inspection forbids this operation.' } });
      }
      return route.fulfill({ json: body });
    }
    if (url.origin !== new URL(PAGES).origin || method !== 'GET'
      || !url.pathname.startsWith(BASE + '/') || request.headers().authorization) {
      report.forbidden_requests++;
      return route.abort('blockedbyclient');
    }
    if (overlay && targets.some(target => url.pathname === `${BASE}/${target.module}/`)) {
      const module = url.pathname.split('/')[2];
      const html = readFileSync(PREVIEW + '/' + module + '/index.html', 'utf8');
      return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
    }
    if (overlay && url.pathname.startsWith(BASE + '/data/')) {
      return route.fulfill({ body: readFileSync(PREVIEW + url.pathname.slice(BASE.length)), contentType: 'application/json' });
    }
    if (overlay && url.pathname === BASE + '/book-assets/styles.css') {
      return route.fulfill({ body: readFileSync(PREVIEW + '/book-assets/styles.css'), contentType: 'text/css' });
    }
    const asset = url.pathname.replace(BASE + '/assets/', '');
    if (overlay && url.pathname.startsWith(BASE + '/assets/') && assets.has(asset)) {
      return route.fulfill({ body: readFileSync(STATIC + '/' + asset),
        contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript' });
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const rejection = /^Failed to load resource: the server responded with a status of (409 \(Conflict\)|401 \(Unauthorized\))$/.exec(message.text());
    const expectedRejection = noteScenario && rejection
      && injectedRejections.has(message.location().url + '|' + rejection[1].slice(0, 3));
    if (message.type() === 'error' && expectedRejection) report.expected_console_rejections.push({
      origin: new URL(message.location().url).origin, path: new URL(message.location().url).pathname,
      status: Number(rejection[1].slice(0, 3)), synthetic_injection_matched: true });
    if (message.type() === 'error' && !expectedRejection) errors.push(message.text());
  });
  page.on('dialog', dialog => noteScenario?.acceptDelete && /删除/.test(dialog.message()) ? dialog.accept() : dialog.dismiss());
  return { ctx, page };
}

async function capture(page, name) {
  await nextFrame(page);
  const dimensions = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
    vertical: document.documentElement.scrollHeight > innerHeight + 1 }));
  if (dimensions.overflow || dimensions.vertical) {
    report.geometry_failure = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      document_width: document.documentElement.scrollWidth, document_height: document.documentElement.scrollHeight,
      boxes: [...document.querySelectorAll('.chat-panel, .chat-messages, .message-bubble, .message-bubble pre, .message-bubble table, .message-bubble thead')]
        .map(node => ({ tag: node.tagName, class_name: node.className, rect: node.getBoundingClientRect().toJSON(),
          position: getComputedStyle(node).position, scroll_height: node.scrollHeight })) }));
    const filename = 'ui-' + name + '-geometry-failure.png';
    await page.screenshot({ path: OUTPUT + '/' + filename, animations: 'disabled' });
    report.screenshots.push(filename);
  }
  assert.equal(dimensions.overflow, false, name + ' horizontal overflow');
  assert.equal(dimensions.vertical, false, name + ' outer-page overflow');
  const filename = 'ui-' + name + '.png';
  await page.screenshot({ path: OUTPUT + '/' + filename, animations: 'disabled' });
  report.screenshots.push(filename);
}

async function ready(page, target) {
  await page.waitForFunction(() => !document.querySelector('#app-shell').hidden
    && !document.querySelector('#detail-content').hidden && !document.querySelector('#note-answer').disabled);
  if (target.module === 'reading' && target.id !== 'human-knowledge-foundations') {
    await page.locator('.book-study-content #sources').waitFor({ state: 'attached' });
    await page.waitForFunction(() => [...document.querySelector('#study-section').options].some(option => option.value === '0'));
  }
}

async function verifyBook(page, id) {
  const claims = readingItems.find(item => item.id === id).evidence.claims;
  const preserved = await page.evaluate(claims => {
    const root = document.querySelector('#book-study').shadowRoot;
    const compact = value => value.replace(/\s+/g, '');
    const text = compact(root.querySelector('.book-study-content').textContent);
    const ids = [...root.querySelectorAll('[id]')].map(node => node.id);
    return claims.every(claim => text.includes(compact(claim.statement))
      && (!claim.explanation || text.includes(compact(claim.explanation)))
      && root.getElementById('claim-' + claim.claim_id))
      && new Set(ids).size === ids.length
      && [...root.querySelectorAll('a[href^="#"]')].every(link => root.getElementById(link.hash.slice(1)));
  }, claims);
  assert.equal(preserved, true, id + ': all claims, explanations and citation backlinks survive');
  const item = readingItems.find(item => item.id === id);
  if (item.evidence.edition) {
    const source = JSON.parse(readFileSync('qa-book-editions.json', 'utf8'))[id];
    const edition = page.locator('.book-study-content #foundation-edition-0');
    await edition.scrollIntoViewIfNeeded();
    assert.equal(await edition.locator('[role="table"] [role="columnheader"]').count(), 2);
    const text = (await edition.textContent()).replace(/\s+/g, '');
    for (const row of source.sections[0].table.rows) for (const cell of row) assert.ok(text.includes(cell.replace(/\s+/g, '')));
    if (source.sections[0].figure) assert.equal(await edition.locator('svg[role="img"]').count(), 1);
    await capture(page, stage + '-editorial-table');
  }
  const summary = page.locator('#detail-placement [data-source="study-takeaway"]');
  const identity = await summary.getAttribute('data-claim-id');
  const claim = claims.find(item => item.claim_id === identity);
  assert.ok(claim, 'Book opening information retains an existing claim identity');
  assert.equal(await summary.locator('.book-summary-text').innerText(), claim.statement);
  assert.equal(await summary.getAttribute('data-claim-kind'), claim.kind);
  assert.equal(await page.locator('#detail-placement summary').count(), 0);
  const before = await page.locator('.book-study-content').textContent();
  const answer = await page.locator('#note-answer').inputValue();
  assert.equal(await page.locator('#book-page-lecture').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.book-study-content #foundation-0').isVisible(), true);
  assert.equal(await page.locator('.book-study-content #argument-map').isVisible(), true, 'Direct teaching retains the original argument steps');
  await page.locator('#book-page-reflection').click();
  assert.equal(await page.locator('#resource-detail').evaluate(node => node.scrollTop), 0);
  assert.equal(await page.locator('.book-study-content #foundation-0').isVisible(), false);
  assert.equal(await page.locator('.book-study-content #argument-map').isVisible(), true);
  assert.equal(await page.locator('.book-study-content #sources').isVisible(), true);
  const reflectionChapters = await page.locator('#study-section option').allTextContents();
  assert.ok(reflectionChapters.length > 2);
  assert.equal(await page.locator('.book-study-content').textContent(), before, 'Two views preserve all text and DOM text offsets');
  assert.equal(await page.locator('#note-answer').inputValue(), answer);
  await page.locator('#book-page-lecture').click();
  assert.equal(await page.locator('#resource-detail').evaluate(node => node.scrollTop), 0);
  assert.notDeepEqual(await page.locator('#study-section option').allTextContents(), reflectionChapters);
  // A source backlink may target the other reading page; reveal it before jumping.
  const backlink = await page.evaluate(() => {
    const root = document.querySelector('#book-study').shadowRoot;
    return [...root.querySelectorAll('#sources a[href^="#"]')].find(link => {
      const target = root.getElementById(link.hash.slice(1));
      return target?.closest('section')?.hidden;
    })?.getAttribute('href');
  });
  assert.ok(backlink, id + ': reflection claims retain source backlinks');
  await page.locator('.book-study-content #sources a[href="' + backlink + '"]').first().click();
  assert.equal(await page.locator('#book-page-reflection').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.book-study-content ' + backlink).isVisible(), true);
  const target = page.locator('.book-study-content ' + backlink);
  assert.equal(await target.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  await page.locator('#book-page-lecture').click();
}


try {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_ACTOR?.toLowerCase(), process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase());
  assert.ok(capsuleRunnerAllowed(process.env));
  capsule();
  assert.match(process.env.EXPECTED_SOURCE_SHA || '', /^[a-f0-9]{40}$/);
  assert.ok(overlay || process.env.GITHUB_REF === 'refs/heads/main');
  assert.ok(!['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(name => process.env[name]));
  stage = 'source-assets';
  report.asset_hashes = Object.fromEntries([...assets].map(name => [name, digest(readFileSync(STATIC + '/' + name))]));
  if (!overlay) {
    const manifest = JSON.parse(Buffer.from(await publicFile('pages-manifest.json')).toString());
    assert.equal(manifest.source_commit, process.env.EXPECTED_SOURCE_SHA);
    assert.equal(manifest.private_records_exported, false);
    for (const name of assets) assert.equal(digest(await publicFile('assets/' + name)), report.asset_hashes[name], name);
  }
  record(stage);
  readingItems = JSON.parse(Buffer.from(await publicFile('data/catalog-reading.json')).toString()).items;
  learningItems = JSON.parse(Buffer.from(await publicFile('data/catalog-learning.json')).toString()).items;
  browser = await chromium.launch({ args: ['--no-proxy-server', '--disable-background-networking'] });
  for (const view of views) {
    stage = view.name + '-login';
    const entry = await context(view, targets[1], false);
    await entry.page.goto(PAGES + 'learning/');
    await entry.page.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(await entry.page.locator('label[for=password]').innerText(), '用户名');
    assert.equal(await entry.page.locator('#public-read').count(), 0);
    assert.equal(await entry.page.locator('#remember-device').count(), 0);
    assert.equal(await entry.page.locator('#password').getAttribute('type'), 'text');
    assert.ok((await entry.page.locator('#access-note').innerText()).includes('共用'));
    await capture(entry.page, stage);
    // The name is a synthetic fixture, never the actual access secret.
    await entry.page.locator('#password').fill('synthetic-access');
    await entry.page.locator('#login-submit').click();
    await ready(entry.page, targets[1]);
    record(stage);
    await entry.ctx.close();
    for (const target of targets) {
      stage = view.name + '-' + target.module;
      const { ctx, page } = await context(view, target);
      await page.goto(PAGES + target.module + '/?resource=' + target.id);
      await ready(page, target);
      assert.equal(await page.locator('#resource-detail').evaluate(node => node.scrollTop), 0, 'Materials open at the top');
      assert.equal(await page.locator('#catalog-scope').innerText(), '全部');
      if (target.module === 'reading') await verifyBook(page, target.id);
      if (view.width >= 1181) {
        assert.equal(await page.locator('.chat-panel').isVisible(), false);
        assert.ok((await page.locator('#resource-detail').boundingBox()).width > 800);
      }
      await capture(page, stage + '-opening');
      if (view.width < 760) await page.locator('button[data-pane=catalog]').click();
      assert.equal(await page.locator('#module-description').count(), 0);
      if (await page.locator('#catalog-location').isVisible()) {
        const beforeList = await page.locator('#resource-list').evaluate(node => { window.originalCatalogList = node.firstElementChild; return node.scrollTop; });
        await page.locator('#catalog-location').click();
        assert.equal(await page.locator('#catalog-location').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#catalog-location').evaluate(node => node === document.activeElement), true,
          'Pointer opening keeps focus on the trigger');
        assert.equal(await page.locator('#resource-list').isVisible(), true);
        assert.equal(await page.locator('#resource-list').evaluate((node, scroll) => node.firstElementChild === window.originalCatalogList && node.scrollTop === scroll, beforeList), true);
        assert.ok(await page.locator('.catalog-topic').count() > 1);
        const menuBox = await page.locator('#catalog-topics').boundingBox();
        const panelBox = await page.locator('.library-panel').boundingBox();
        assert.ok(menuBox.x >= panelBox.x && menuBox.x + menuBox.width <= panelBox.x + panelBox.width + 1);
        assert.ok(menuBox.y + menuBox.height <= panelBox.y + panelBox.height + 1, 'Topic choices fit the visible catalog');
        await page.keyboard.press('End');
        assert.equal(await page.locator('.catalog-topic').last().evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Home');
        assert.equal(await page.locator('.catalog-topic').first().evaluate(node => node === document.activeElement), true);
        await capture(page, stage + '-topics');
        const originalTitle = await page.locator('#detail-title').innerText();
        const topic = page.locator('.catalog-topic').nth(1);
        const scope = await topic.getAttribute('data-catalog-scope');
        await topic.click();
        assert.equal(await page.locator('#catalog-location').getAttribute('aria-expanded'), 'false');
        assert.ok(await page.locator('[data-resource-id]').count() > 0);
        assert.equal(await page.locator('#detail-title').innerText(), originalTitle, 'Browsing a theme does not change material context');
        await page.locator('#catalog-location').click();
        assert.equal(await page.locator('.catalog-topic[aria-current="true"]').getAttribute('data-catalog-scope'), scope);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#catalog-location').getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('#catalog-location').evaluate(node => node === document.activeElement), true);
        await page.locator('#catalog-location').click();
        await page.locator('#resource-search').click();
        assert.equal(await page.locator('#catalog-location').getAttribute('aria-expanded'), 'false');
        await page.locator('#catalog-location').click();
        await page.locator('[data-catalog-scope=""]').click();
      } else {
        assert.equal(target.module, 'investment', 'Single-topic public material does not need a topic switch');
        assert.equal(await page.locator('#catalog-topics').isVisible(), false);
      }
      if (target.module === 'learning' || target.module === 'reading') {
        assert.equal(await page.locator('#resource-content').inputValue(), 'study');
        const catalog = target.module === 'learning' ? learningItems : readingItems;
        const expected = catalog.filter(item => target.module === 'learning' ? item.evidence?.lesson : item.kind === 'book').length;
        assert.equal(await page.locator('[data-resource-id]').count(), expected);
        const total = catalog.length;
        await page.locator('#resource-content').selectOption('all');
        assert.equal(await page.locator('[data-resource-id]').count(), total);
        await page.locator('#resource-content').selectOption('study');
        if (target.module === 'learning') {
          await page.locator('#resource-search').fill('工程交付');
          assert.equal(await page.locator('[data-resource-id=d02-v33-u6]').count(), 1);
          await page.locator('#resource-search').fill('');
          assert.equal(await page.locator('[data-resource-id]').count(), expected);
          const active = page.locator(`[data-resource-id=${target.id}]`);
          const bounds = await active.boundingBox(), list = await page.locator('#resource-list').boundingBox();
          assert.ok(bounds.y >= list.y && bounds.y + bounds.height <= list.y + list.height,
            'Clearing search restores the selected catalog row into view');
          await active.focus();
          const nextId = await page.locator('[data-resource-id]').evaluateAll((rows, id) =>
            rows[rows.findIndex(row => row.dataset.resourceId === id) + 1]?.dataset.resourceId, target.id);
          assert.ok(nextId, 'Selected study material has a next catalog row');
          await page.keyboard.press('ArrowDown');
          await page.waitForFunction(id => document.activeElement?.dataset.resourceId === id
            && !document.querySelector('#note-answer').disabled, nextId);
          await page.keyboard.press('ArrowUp');
          await page.waitForFunction(id => document.activeElement?.dataset.resourceId === id
            && !document.querySelector('#note-answer').disabled, target.id);
        }
      }
      await capture(page, stage + '-catalog');
      if (view.width < 760) await page.locator('button[data-pane=read]').click();
      if (target.module === 'reading') {
        await page.locator('#book-page-reflection').click();
        assert.equal(await page.locator('#resource-detail').evaluate(node => node.scrollTop), 0);
        await page.locator('.book-study-content .argument-map').scrollIntoViewIfNeeded();
      } else {
        const options = await page.locator('#study-section option').evaluateAll(nodes => nodes.map(node => node.value));
        await page.locator('#study-section').selectOption(options[Math.min(2, options.length - 1)]);
        const table = page.locator('#detail-body .study-table').first();
        if (await table.count()) await table.scrollIntoViewIfNeeded();
      }
      await capture(page, stage + '-reasoning');
      const readingTop = await page.locator('#resource-detail').evaluate(node => node.scrollTop);
      assert.equal(await page.locator('#book-reading-modes').isVisible(), target.module === 'reading');
      assert.equal(await page.locator('.detail-tabs').count(), 0, 'Notes remain in the separate pane');
      await page.locator('#exercise-panel').scrollIntoViewIfNeeded();
      await page.locator('#answer-tools summary').click();
      assert.equal(await page.locator('#note-organization').innerText(), '论证前提与反例 · 按前提、推理与反例组织练习回答。');
      assert.ok((await page.locator('#exercise-prompt').innerText()).length > 20);
      assert.equal(await page.locator('#detail-body').isHidden(), target.module === 'reading');
      await capture(page, stage + '-practice');
      await page.locator('#resource-detail').evaluate((node, top) => { node.scrollTop = top; }, readingTop);
      assert.ok(Math.abs(await page.locator('#resource-detail').evaluate(node => node.scrollTop) - readingTop) <= 3);
      if (target.module === 'reading') await page.locator('.book-study-content #sources').scrollIntoViewIfNeeded();
      else if (await page.locator('#study-section option[value=extensions]').count()) await page.locator('#study-section').selectOption('extensions');
      else await page.locator('#study-section').selectOption(await page.locator('#study-section option').last().getAttribute('value'));
      await capture(page, stage + '-sources');
      if (target.module === 'reading') await page.locator('#book-page-lecture').click();
      await page.locator('#study-section').selectOption('0');
      if (view.width >= 1181) await page.locator('#discussion-toggle').click();
      else await page.locator('button[data-pane=chat]').click();
      assert.equal(await page.locator('.chat-panel').isVisible(), true);
      await page.locator('.discussion-prompts button').last().click();
      assert.ok((await page.locator('#chat-input').inputValue()).includes('先让我尝试回答'));
      await page.locator('#chat-input').fill('');
      await page.locator('#history-drawer summary').click();
      assert.equal(await page.locator('.session-button').count(), 2);
      const titles = await page.locator('.session-button .record-title').allTextContents();
      assert.equal(new Set(titles).size, 2);
      assert.equal(titles.includes('模拟材料标题'), false);
      assert.equal(await page.locator('.session-button .record-summary').count(), 2);
      await capture(page, stage + '-history');
      await page.locator(`[data-session-id="${sessionId}"]`).click();
      await page.locator('.message.assistant .study-table').waitFor();
      assert.equal(await page.locator('.message.assistant h3').innerText(), '从问题到结论');
      assert.equal(await page.locator('.message.assistant ol li').count(), 3);
      assert.equal(await page.locator('.message.assistant pre').innerText(), 'total = 0\n# 代码内的。## 标记保持原样');
      assert.ok((await page.locator('.message.assistant .message-bubble').innerText()).includes('教学代码。'));
      assert.equal(await page.locator('#discussion-model').inputValue(), 'claude-opus-5-5');
      assert.equal(await page.locator('#discussion-effort').inputValue(), 'high');
      assert.deepEqual(await page.locator('#discussion-effort option').allTextContents(), ['low', 'medium', 'high', 'xhigh', 'max']);
      assert.equal(await page.locator('.discussion-effort-label').count(), 0);
      await page.locator('#discussion-effort').selectOption('high');
      assert.equal(await page.locator('#discussion-effort option[value=max]').count(), 1);
      await page.locator('#discussion-model').selectOption('gpt-6.1-sol');
      assert.equal(await page.locator('#discussion-effort').inputValue(), 'high', 'Each model starts at high');
      assert.equal(await page.locator('#discussion-effort option[value=max]').count(), 0);
      await page.locator('#discussion-model').selectOption('claude-opus-5-5');
      await page.locator('#discussion-effort').selectOption('medium');
      await page.locator('#discussion-model').selectOption('gpt-6.1-sol');
      assert.equal(await page.locator('#discussion-effort').inputValue(), 'high');
      await page.locator('#discussion-model').selectOption('claude-opus-5-5');
      assert.equal(await page.locator('#discussion-effort').inputValue(), 'medium', 'Explicit efforts are remembered per model');
      await capture(page, stage + '-discussion');
      await page.locator('#discussion-close').click();
      assert.equal(await page.locator('.chat-panel').isVisible(), false);
      if (view.width >= 1181) {
        await page.locator('#focus-toggle').click();
        assert.equal(await page.locator('.library-panel').isVisible(), false);
        await page.locator('#focus-toggle').click();
      }
      record(stage);
      await ctx.close();
    }
  }
  for (const target of targets) {
    stage = 'delete-conversation-' + target.module;
    const notes = { record: { schema_version: '1.0.0', entries: [], sha: null }, writes: [], acceptDelete: true };
    const { ctx, page } = await context(views[0], target, true, null, notes);
    await page.goto(PAGES + target.module + '/?resource=' + target.id); await ready(page, target);
    await page.locator('#discussion-toggle').click();
    await page.locator('#history-drawer summary').click();
    await page.locator(`[data-session-id="${sessionId}"]`).click();
    await page.locator('.message.assistant').waitFor();
    await page.locator('#chat-input').fill('模拟未发送草稿，删除历史后仍须保留。');
    await page.locator('#history-drawer summary').click();
    await page.locator(`[data-delete-session="${sessionId}"]`).click();
    await page.waitForFunction(() => document.querySelector('#chat-status').textContent === '对话已删除并同步');
    assert.equal(await page.locator(`[data-session-id="${sessionId}"]`).count(), 0);
    assert.equal(await page.locator('.session-button').count(), 1);
    assert.equal(await page.locator('.message').count(), 0);
    assert.equal(await page.locator('#chat-input').inputValue(), '模拟未发送草稿，删除历史后仍须保留。');
    await capture(page, stage); await page.reload(); await ready(page, target);
    assert.equal(await page.locator(`[data-session-id="${sessionId}"]`).count(), 0);
    record(stage); await ctx.close();
  }
  for (const item of readingItems.filter(item => item.kind === 'book' && item.id !== targets[0].id)) {
    stage = 'book-evidence-' + item.id;
    const target = { module: 'reading', id: item.id };
    const { ctx, page } = await context(views[0], target);
    await page.goto(PAGES + 'reading/?resource=' + item.id);
    await ready(page, target);
    await verifyBook(page, item.id);
    await capture(page, stage + '-foundation');
    await page.locator('.book-study-content #foundation-source-passage').scrollIntoViewIfNeeded();
    await capture(page, stage + '-excerpt');
    record(stage);
    await ctx.close();
  }
  for (const view of [views[2], views[3]]) {
    for (const id of ['adam-smith-wealth-of-nations', 'charles-darwin-origin-of-species', 'john-snow-mode-communication-cholera']) {
      stage = view.name + '-' + id + '-editorial-figure';
      const target = { module: 'reading', id };
      const { ctx, page } = await context(view, target);
      await page.goto(PAGES + 'reading/?resource=' + id);
      await ready(page, target);
      const figure = page.locator('.book-study-content #foundation-edition-0 svg[role="img"]');
      await figure.scrollIntoViewIfNeeded();
      assert.ok(await figure.getAttribute('aria-label'));
      assert.equal(await figure.evaluate(node => node.getBoundingClientRect().width <= node.closest('section').getBoundingClientRect().width + 2), true);
      await capture(page, stage);
      record(stage);
      await ctx.close();
    }
  }
  for (const view of views.slice(0, 4)) {
    for (const [id, selector] of [['euclid-elements', '.geometry-figure'], ['confucius-analects', '.classical-passage']]) {
      stage = view.name + '-' + id + '-specialist';
      const target = { module: 'reading', id };
      const { ctx, page } = await context(view, target);
      await page.goto(PAGES + 'reading/?resource=' + id);
      await ready(page, target);
      await page.locator('.book-study-content ' + selector).first().scrollIntoViewIfNeeded();
      await capture(page, stage);
      record(stage);
      await ctx.close();
    }
  }
  // Inspect reviewed refinements at the paragraphs rather than only their opening screens.
  for (const view of [views[0], views[1], views[2], views[3]]) {
    for (const [module, id, text] of [
      ['reading', 'human-knowledge-foundations', '先做一个小对照'],
      ['learning', 'd02-v33-u5', '下面是一份虚构作答'],
      ['learning', 'd11-v33-u1', '1元支出'],
      ['trading', 'operational-reconciliation', '沿用全部虚构事件'],
      ['trading', 'earnings-cashflow', '间接法有两种写法'],
      ['investment', 'investment-workspace', '年折现率'],
    ]) {
      stage = 'refinement-' + module + '-' + id + '-' + view.name;
      const target = { module, id };
      const { ctx, page } = await context(view, target);
      await page.goto(PAGES + module + '/?resource=' + id);
      await ready(page, target);
      const paragraph = page.locator('#detail-body p').filter({ hasText: text }).last();
      await paragraph.scrollIntoViewIfNeeded();
      if (module === 'investment') {
        const calculation = await paragraph.innerText();
        assert.ok(calculation.includes('1.10') && calculation.includes('63.64') && calculation.includes('100'));
      }
      await capture(page, stage);
      if (module === 'investment') {
        await page.locator('#detail-body p').filter({ hasText: '题设初始可用现金' }).last().scrollIntoViewIfNeeded();
        await capture(page, stage + '-cash');
      }
      record(stage); await ctx.close();
    }
  }
  for (const view of [views[0], views[3]]) {
    for (const target of targets.slice(0, 2)) {
      stage = 'reading-notes-' + target.module + '-' + view.name;
      const notes = { record: { schema_version: '1.0.0', entries: [], sha: null }, writes: [] };
      const { ctx, page } = await context(view, target, true, null, notes);
      await page.goto(PAGES + target.module + '/?resource=' + target.id);
      await ready(page, target);
      await page.waitForFunction(() => !document.querySelector('#add-reading-note').disabled);
      const selector = target.module === 'reading' ? '.book-study-content #foundation-0 p:not(.foundation-basis)' : '#detail-body .study-part p';
      await page.locator(selector).first().scrollIntoViewIfNeeded();
      const selected = await page.evaluate(module => {
        const root = module === 'reading' ? document.querySelector('#book-study').shadowRoot : document.querySelector('#detail-body');
        const p = [...root.querySelectorAll(module === 'reading' ? '#foundation-0 p:not(.foundation-basis)' : '.study-part p')]
          .find(node => node.textContent.length > 80);
        const node = [...p.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 10);
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(30, node.length));
        const selection = root.getSelection?.() || getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return range.toString();
      }, target.module);
      await page.locator('#annotate-selection').waitFor({ state: 'visible' });
      await page.locator('#annotate-selection').click();
      assert.equal(await page.locator('#annotation-quote').innerText(), selected);
      await page.locator('#annotation-comment').fill('模拟学习笔记：把这段解释和例子连起来。');
      await capture(page, stage + '-dialog');
      await page.waitForFunction(() => document.querySelector('#annotation-error').textContent === '已自动同步');
      assert.equal(await page.locator('#annotation-dialog').isVisible(), true);
      assert.equal(notes.writes.length, 1, 'Typing automatically saves one version without closing the editor');
      await page.locator('#save-reading-note').click();
      await page.locator('#annotation-dialog').waitFor({ state: 'hidden' });
      assert.equal(notes.writes.length, 1);
      assert.match(notes.writes[0].anchor.source_sha256, /^[a-f0-9]{64}$/);
      assert.equal(await page.locator('#notes-panel').isVisible(), true);
      await page.waitForFunction(() => document.querySelector('.reading-note-title')?.textContent === '解释与例子的联系');
      assert.ok((await page.locator('.reading-note-title').innerText()).length > 0);
      for (const selector of ['.reading-note-delete', '.reading-note-body', '.reading-note-quote']) {
        assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
      }
      await page.locator('.reading-note').scrollIntoViewIfNeeded();
      await capture(page, stage + '-saved');
      await page.reload(); await ready(page, target);
      await page.waitForFunction(() => !document.querySelector('#add-reading-note').disabled);
      assert.equal(await page.locator('#notes-panel').isVisible(), false);
      await page.locator(view.name.startsWith('desktop') ? '#notes-toggle' : 'button[data-pane=notes]').click();
      assert.equal(await page.locator('.reading-note-title').innerText(), '解释与例子的联系');
      assert.equal(await page.locator('.reading-note-body .record-summary').innerText(), '用例子核对解释中的推理步骤。');
      assert.equal(notes.organizationCalls, 1);
      if (target.module === 'reading') {
        await page.locator('#notes-close').click();
        await page.locator('#book-page-reflection').click();
        await page.locator(view.name.startsWith('desktop') ? '#notes-toggle' : 'button[data-pane=notes]').click();
      }
      await page.locator('.reading-note-quote').click();
      if (target.module === 'reading') assert.equal(await page.locator('#book-page-lecture').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#text-section').isVisible(), true);
      if (!await page.locator('#notes-panel').isVisible()) await page.locator(view.name.startsWith('desktop') ? '#notes-toggle' : 'button[data-pane=notes]').click();
      await page.locator('.reading-note-body').click();
      await page.locator('#annotation-comment').fill('模拟冲突草稿');
      await page.locator('#save-reading-note').click();
      await page.locator('#reload-reading-notes').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#annotation-comment').inputValue(), '模拟冲突草稿');
      await page.locator('#reload-reading-notes').click();
      await page.locator('#merge-reading-note').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#save-reading-note').isDisabled(), true);
      assert.equal(await page.locator('#annotation-latest').innerText(), '另一窗口的模拟修改');
      await capture(page, stage + '-conflict');
      await page.locator('#merge-reading-note').click();
      await page.locator('#annotation-comment').fill('模拟合并：保留另一窗口的修改，并补上例子。');
      await page.locator('#save-reading-note').click();
      await page.locator('#annotation-dialog').waitFor({ state: 'hidden' });
      assert.equal(notes.writes.length, 3);
      assert.equal(notes.record.entries[0].revisions.length, 2);
      if (target.module === 'reading') {
        await page.locator('#notes-close').click();
        await page.locator('#book-page-reflection').click();
        await page.locator(view.name.startsWith('desktop') ? '#notes-toggle' : 'button[data-pane=notes]').click();
      }
      await page.locator('.reading-note-body').click();
      await page.locator('#annotation-comment').fill('模拟过期草稿');
      await page.locator('#save-reading-note').click();
      await page.locator('#login-view').waitFor({ state: 'visible' });
      await page.locator('#password').fill('synthetic-access');
      await page.locator('#login-submit').click();
      await page.locator('#annotation-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#annotation-comment').inputValue(), '模拟过期草稿');
      if (target.module === 'reading') assert.equal(await page.locator('#book-page-reflection').getAttribute('aria-selected'), 'true', 'Reconnect preserves the active book page');
      await capture(page, stage + '-reauth-draft');
      await page.locator('#annotation-comment').fill('模拟重新连接后的笔记');
      await page.locator('#save-reading-note').click();
      await page.locator('#annotation-dialog').waitFor({ state: 'hidden' });
      assert.equal(notes.writes.length, 5);
      assert.equal(notes.record.entries[0].revisions.length, 3);
      notes.acceptDelete = true;
      await page.locator('.reading-note-delete').click();
      await page.waitForFunction(() => document.querySelectorAll('.reading-note').length === 0);
      assert.equal(notes.deletes, 1);
      await capture(page, stage + '-deleted');
      await page.locator('#notes-close').click();
      assert.equal(await page.locator('#notes-panel').isVisible(), false);
      await page.locator('#text-section').evaluate(node => node.scrollIntoView({ block: 'start' }));
      // Navigation focuses this panel programmatically after pointer input;
      // its top-left corner may sit behind the sticky mobile orientation bar.
      await page.locator('#text-section').focus();
      assert.equal(await page.locator('#text-section').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
      await page.locator('#study-section').focus(); await page.keyboard.press('Tab');
      assert.notEqual(await page.evaluate(() => {
        let focused = document.activeElement;
        while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
        return getComputedStyle(focused).outlineStyle;
      }), 'none');
      record(stage);
      await ctx.close();
    }
  }
  for (const view of views.filter(view => ['desktop-light', 'mobile-dark'].includes(view.name))) {
    stage = 'wealth-of-nations-' + view.name;
    const target = { module: 'reading', id: 'adam-smith-wealth-of-nations' };
    const { ctx, page } = await context(view, target);
    await page.goto(PAGES + 'reading/?resource=' + target.id);
    await ready(page, target);
    assert.equal(await page.locator('#detail-title').innerText(), '国富论');
    const subtitle = await page.locator('#detail-subtitle').innerText();
    assert.ok(subtitle.includes('Adam Smith') && subtitle.includes('1776'));
    assert.ok(!subtitle.includes('研究状态'));
    assert.equal(await page.locator('#detail-placement').evaluate(node => node.tagName), 'DIV');
    assert.equal(await page.locator('#detail-placement summary').count(), 0);
    assert.ok(!(await page.locator('#detail-placement').innerText()).includes('学习路径'));
    assert.ok(!(await page.locator('#detail-placement').textContent()).includes('已评审材料'));
    await capture(page, stage + '-title');
    assert.ok((await page.locator('#detail-placement').innerText()).includes('财富'));
    assert.ok(!(await page.locator('#detail-placement').innerText()).includes('从财报到'));
    await capture(page, stage + '-path');
    for (const id of ['foundation-1', 'foundation-2', 'foundation-5', 'foundation-7']) {
      const section = page.locator('.book-study-content #' + id);
      if (await section.count()) {
        await section.scrollIntoViewIfNeeded();
        await capture(page, stage + '-' + id);
      }
    }
    record(stage);
    await ctx.close();
  }
  for (const view of [
    { name: 'short-desktop-light', width: 1280, height: 400, theme: 'light' },
    { name: 'short-mobile-dark', width: 390, height: 480, theme: 'dark' },
  ]) {
    stage = view.name + '-topic-fit';
    const target = targets[0];
    const { ctx, page } = await context(view, target);
    await page.goto(PAGES + 'reading/?resource=' + target.id);
    await ready(page, target);
    if (view.width < 760) await page.locator('button[data-pane=catalog]').click();
    const trigger = page.locator('#catalog-location');
    const before = await page.locator('#resource-list').evaluate(node => {
      node.scrollTop = node.scrollHeight;
      window.shortCatalogNode = node.firstElementChild;
      return node.scrollTop;
    });
    await trigger.click();
    const menu = page.locator('#catalog-topics');
    assert.equal(await menu.getAttribute('data-placement'), 'above');
    const bounds = await menu.boundingBox();
    const panel = await page.locator('.library-panel').boundingBox();
    assert.ok(bounds.y >= panel.y && bounds.y + bounds.height <= panel.y + panel.height,
      'Short-screen choices stay inside the visible catalog');
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= view.height);
    await page.keyboard.press('End');
    assert.equal(await page.locator('.catalog-topic').last().evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#resource-list').evaluate((node, scroll) =>
      node.firstElementChild === window.shortCatalogNode && node.scrollTop === scroll, before), true);
    await capture(page, stage);
    await page.keyboard.press('Escape');
    await trigger.press('ArrowDown');
    assert.equal(await page.locator('.catalog-topic').first().evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    record(stage);
    await ctx.close();
  }
  stage = 'book-pages-keyboard-and-model-preference-migration';
  {
    const target = targets[0];
    const { ctx, page } = await context(views[0], target);
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('hub-discussion-choice-v2:reading'))
        localStorage.setItem('hub-discussion-choice-v2:reading', JSON.stringify({ model: 'claude-opus-5-5', effort: 'medium' }));
    });
    await page.goto(PAGES + 'reading/?resource=' + target.id); await ready(page, target);
    assert.equal(await page.locator('#resource-detail').evaluate(node => node.scrollTop), 0);
    assert.equal(await page.locator('#discussion-model').inputValue(), 'claude-opus-5-5');
    assert.equal(await page.locator('#discussion-effort').inputValue(), 'high');
    await page.locator('#book-page-lecture').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#book-page-reflection').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#book-page-reflection').evaluate(node => node === document.activeElement), true);
    assert.notEqual(await page.locator('#book-page-reflection').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#book-page-lecture').getAttribute('aria-selected'), 'true');
    await page.locator('#discussion-toggle').click();
    await page.locator('#discussion-effort').selectOption('medium');
    await page.reload(); await ready(page, target);
    assert.equal(await page.locator('#discussion-model').inputValue(), 'claude-opus-5-5');
    assert.equal(await page.locator('#discussion-effort').inputValue(), 'medium');
    assert.equal(await page.locator('#resource-detail').evaluate(node => node.scrollTop), 0);
    assert.ok(await page.evaluate(() => localStorage.getItem('hub-discussion-choice-v2:reading')));
    record(stage); await ctx.close();
  }
  stage = 'book-summary-rejects-obsolete-study';
  {
    const original = targets[0], replacement = { module: 'reading', id: 'adam-smith-wealth-of-nations' };
    const { ctx, page } = await context(views[0], original);
    await page.goto(PAGES + 'reading/?resource=' + original.id);
    await ready(page, original);
    await page.locator('#catalog-location').click();
    await page.locator('[data-catalog-scope=""]').click();
    await page.locator('[data-resource-id="' + replacement.id + '"]').click();
    await ready(page, replacement);
    let release, arrived;
    const started = new Promise(resolve => { arrived = resolve; });
    await page.route('**/data/books/abelson-sussman-sicp.json*', async route => {
      await new Promise(resolve => { release = resolve; arrived(); });
      await route.fulfill({ json: JSON.parse(Buffer.from(await publicFile('data/books/' + original.id + '.json')).toString()) });
    });
    await page.locator('[data-resource-id="' + original.id + '"]').click();
    await started;
    await page.locator('[data-resource-id="' + replacement.id + '"]').click();
    await ready(page, replacement);
    await verifyBook(page, replacement.id);
    const summary = await page.locator('#detail-placement').innerText();
    const response = page.waitForResponse(item => item.url().includes('/data/books/' + original.id + '.json'));
    release();
    await response;
    await nextFrame(page);
    assert.equal(await page.locator('#detail-title').innerText(), '国富论');
    assert.equal(await page.locator('#book-study').getAttribute('data-book-id'), replacement.id);
    assert.equal(await page.locator('#detail-placement').innerText(), summary);
    record(stage);
    await ctx.close();
  }
  stage = 'module-switch-cached-session-no-login-flash';
  {
    const notes = { record: { schema_version: '1.0.0', entries: [], sha: null }, writes: [] };
    const { ctx, page } = await context(views[0], targets[0], true, null, notes);
    await page.goto(PAGES + 'reading/?resource=' + targets[0].id); await ready(page, targets[0]);
    notes.delayAuth = true;
    await page.locator('.module-nav a[data-module=learning]').click();
    await page.waitForFunction(() => document.querySelector('.module-nav [aria-current=page]')?.dataset.module === 'learning'
      && !document.querySelector('#app-shell').hidden);
    assert.equal(await page.locator('#login-view').isVisible(), false);
    assert.equal(await page.locator('#chat-send').isDisabled(), true);
    assert.equal(notes.writes.length, 0);
    await capture(page, stage + '-connecting');
    assert.equal(typeof notes.releaseAuth, 'function');
    notes.releaseAuth(); notes.delayAuth = false;
    await ready(page, targets[1]);
    record(stage); await ctx.close();
  }
  for (const target of targets) {
    stage = 'chat-packet-match-' + target.module;
    const paths = [`data/catalog-${target.module}.json`];
    if (target.module === 'reading') paths.push(`data/books/${target.id}.json`);
    const expected = {};
    for (const path of paths) expected[path] = digest(await publicFile(path));
    const chat = { expected, posts: [], release: { packaged: true,
      chat_packet_validation: 'sha256-v1', packets_sha256: expected } };
    const { ctx, page } = await context(views[0], target, true, chat);
    await page.goto(PAGES + target.module + '/?resource=' + target.id);
    await ready(page, target);
    await page.locator('#discussion-toggle').click();
    await page.locator('#chat-input').fill('模拟问题：这一结论依赖哪些前提？');
    await page.locator('#chat-send').click();
    await page.waitForFunction(() => document.querySelector('#chat-send').disabled === false
      && document.querySelector('#chat-messages').textContent.includes('资料版本一致。这是模拟回复'));
    assert.equal(chat.posts.length, 1);
    assert.equal(await page.locator('#chat-input').inputValue(), '');
    await capture(page, stage);
    record(stage);
    await ctx.close();
  }
  for (const view of [views[0], views[4]]) {
    stage = 'chat-packet-drift-' + view.name;
    const target = targets[1];
    const chat = { expected: {}, posts: [], release: { packaged: true,
      chat_packet_validation: 'sha256-v1', packets_sha256: { 'data/catalog-learning.json': '0'.repeat(64) } } };
    const { ctx, page } = await context(view, target, true, chat);
    await page.goto(PAGES + target.module + '/?resource=' + target.id);
    await ready(page, target);
    if (view.width >= 1181) await page.locator('#discussion-toggle').click();
    else await page.locator('button[data-pane=chat]').click();
    const question = '模拟问题：版本不一致时保留这条问题。';
    await page.locator('#chat-input').fill(question);
    await page.locator('#chat-send').click();
    await page.waitForFunction(() => document.querySelector('#chat-send').disabled === false
      && document.querySelector('#chat-status').textContent.includes('资料版本尚未一致'));
    assert.equal(chat.posts.length, 0);
    assert.equal(await page.locator('#chat-input').inputValue(), question);
    await capture(page, stage);
    record(stage);
    await ctx.close();
  }
  for (const view of [views[0], views[4]]) {
    stage = 'chat-lost-completion-' + view.name;
    const target = targets[1], expected = {};
    const path = `data/catalog-${target.module}.json`;
    expected[path] = digest(await publicFile(path));
    const chat = { expected, posts: [], recovery: true, release: { packaged: true,
      chat_packet_validation: 'sha256-v1', packets_sha256: expected } };
    const { ctx, page } = await context(view, target, true, chat);
    await page.goto(PAGES + target.module + '/?resource=' + target.id);
    await ready(page, target);
    if (view.width >= 1181) await page.locator('#discussion-toggle').click();
    else await page.locator('button[data-pane=chat]').click();
    const question = '模拟问题：恢复已保存但传输中断的回答。';
    await page.locator('#chat-input').fill(question);
    await page.locator('#chat-send').click();
    await page.waitForFunction(() => document.querySelector('#chat-send').disabled === false
      && document.querySelector('#chat-messages').textContent.includes('这次回复没有完成'));
    assert.equal(chat.posts.length, 1);
    assert.equal(await page.locator('#chat-input').inputValue(), question);
    assert.ok((await page.locator('#chat-status').textContent()).includes('服务回复传输未完成'));
    assert.equal((await page.locator('#chat-messages').textContent()).includes('JSON'), false);
    await capture(page, stage + '-retained');
    await page.locator('#chat-send').click();
    await page.waitForFunction(() => document.querySelector('#chat-send').disabled === false
      && document.querySelector('#chat-messages').textContent.includes('资料版本一致。这是模拟回复'));
    assert.equal(chat.posts.length, 2);
    assert.equal(chat.releaseReads, 1);
    assert.equal(await page.locator('#chat-input').inputValue(), '');
    await capture(page, stage + '-recovered');
    record(stage);
    await ctx.close();
  }
  assert.equal(report.forbidden_requests, 0);
  assert.equal(report.expected_annotation_conflicts, 4);
  assert.equal(report.expected_annotation_expiries, 4);
  assert.deepEqual(errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.failed_stage = stage; report.failure = error.message;
  const failedPage = browser?.contexts().flatMap(context => context.pages()).at(-1);
  if (failedPage) {
    report.failure_ui = await failedPage.evaluate(() => Object.fromEntries(
      ['login-error', 'catalog-status', 'detail-empty', 'note-status'].map(id =>
        [id, document.getElementById(id)?.textContent?.slice(0, 300) || '']))).catch(() => ({}));
    await failedPage.screenshot({ path: OUTPUT + '/ui-failure.png' }).catch(() => {});
  }
} finally {
  if (browser) await browser.close();
  report.errors = errors; report.elapsed_seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(OUTPUT + '/ui-report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
console.log(`Public UI inspection ${report.status}; checks=${report.checks.length}; screenshots=${report.screenshots.length}; stage=${stage}`);
if (report.failure) console.error(report.failure);
process.exitCode = report.status === 'PASS' ? 0 : 1;
