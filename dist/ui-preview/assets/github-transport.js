/* GitHub-only transport. Tokens never enter assets, records or model inputs. */
window.HUB_GITHUB_TRANSPORT = (config, dependencies = {}) => {
  const fetcher = dependencies.fetch || window.fetch.bind(window);
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const storage = dependencies.storage || (() => window.sessionStorage);
  const modules = new Set(['reading', 'learning', 'trading', 'investment']);
  const branch = 'personal-state';
  const owner = config.owner.toLowerCase();
  const base = config.base.replace(/\/$/, '');
  const prefix = `personal/${owner}`;
  const cache = new Map();
  let navigation = null, navigationDirty = false, navigationTimer, navigationRevision = 0;
  const tokenKey = `hub-github-token:${config.repository}`;
  let token = null;
  try { token = storage().getItem(tokenKey); } catch { /* Reconnect manually. */ }
  const identity = value => /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value || '');
  const uuid = () => crypto.randomUUID().replaceAll('-', '');
  const encode = value => btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), byte => String.fromCharCode(byte)).join(''));
  const decode = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g, '')), c => c.charCodeAt(0))));
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const sessionPath = (module, id) => `${prefix}/sessions/${module}/${id.slice(0, 2)}/${id}.json`;

  async function restoreNavigation() {
    navigation = await read(`${prefix}/preferences/${config.module}.json`) || { schema_version: '1.0.0', sections: {} };
    if (!navigation.sections || typeof navigation.sections !== 'object') throw new Error('阅读位置记录格式无效。');
    try {
      if (identity(navigation.last_resource_id)) window.localStorage.setItem(`hub-last-material-v1:${config.module}`, navigation.last_resource_id);
      for (const [resource, section] of Object.entries(navigation.sections)) {
        if (identity(resource) && typeof section === 'string' && section.length <= 500) {
          window.localStorage.setItem(`hub-section-v1:${config.module}:${resource}`, section);
        }
      }
    } catch { /* Reading remains usable when local storage is unavailable. */ }
  }

  async function flushNavigation() {
    clearTimeout(navigationTimer);
    if (!navigationDirty || !navigation) return;
    const revision = navigationRevision;
    const snapshot = { ...navigation, sections: { ...navigation.sections }, updated_at: new Date().toISOString() };
    await write(`${prefix}/preferences/${config.module}.json`, snapshot);
    if (revision === navigationRevision) navigationDirty = false;
    // A newer scroll during the request remains dirty for the next flush.
  }

  function rememberNavigation(module, resource, section) {
    if (!navigation || module !== config.module || !identity(resource)) return;
    navigation.last_resource_id = resource;
    if (typeof section === 'string' && section.length <= 500) navigation.sections[resource] = section;
    navigationDirty = true;
    navigationRevision++;
    clearTimeout(navigationTimer);
    navigationTimer = setTimeout(() => flushNavigation().catch(() => {
      const status = document.getElementById('resume-status');
      if (status) { status.hidden = false; status.textContent = '位置尚未同步；当前浏览器仍保留位置。'; }
    }), 20000);
  }

  async function github(path, method = 'GET', body) {
    if (!token) return json({ detail: '请连接你的 GitHub 账号。' }, 401);
    const response = await fetcher(`https://api.github.com/repos/${config.repository}${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401) {
      token = null;
      try { storage().removeItem(tokenKey); } catch { /* Memory already cleared. */ }
      const error = new Error('GitHub 连接已过期。'); error.status = 401; throw error;
    }
    if (response.status === 403) throw new Error('GitHub 权限不足或请求额度已用尽；草稿仍保留，请检查连接。');
    return response;
  }

  async function read(path) {
    const response = await github(`/contents/${path}?ref=${branch}`);
    if (response.status === 404) { cache.set(path, { sha: null, data: null }); return null; }
    if (!response.ok) throw new Error(`GitHub 读取失败（${response.status}）；不会用空白覆盖。`);
    const blob = await response.json();
    if (blob.encoding !== 'base64' || blob.size > 2000000) throw new Error('记录格式或大小超出当前范围。');
    const data = decode(blob.content);
    cache.set(path, { sha: blob.sha, data });
    return data;
  }

  async function write(path, data) {
    if (!cache.has(path)) throw new Error('请先成功读取记录，再保存修改。');
    const previous = cache.get(path);
    const response = await github(`/contents/${path}`, 'PUT', { message: 'state: save personal learning record',
      branch, content: encode(data), ...(previous.sha ? { sha: previous.sha } : {}) });
    if ([409, 422].includes(response.status)) throw new Error('另一设备已修改这份记录。你的草稿已保留，请重新读取并合并。');
    if (!response.ok) throw new Error(`GitHub 保存失败（${response.status}）。`);
    const saved = await response.json();
    cache.set(path, { sha: saved.content.sha, data });
    return data;
  }

  async function connect(value) {
    token = value.trim();
    const account = await fetcher('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
    if (!account.ok || (await account.json()).login.toLowerCase() !== owner) {
      token = null; throw new Error('请连接配置的个人 GitHub 账号。');
    }
    const repository = await github('');
    if (!repository.ok || (await repository.json()).private !== true) {
      token = null; throw new Error('学习记录必须保存在私有仓库。');
    }
    const reference = await github(`/git/ref/heads/${branch}`);
    if (reference.status === 404) {
      const current = await github('/git/ref/heads/main');
      if (!current.ok) throw new Error('无法读取源仓库 main 分支。');
      const created = await github('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: (await current.json()).object.sha });
      if (!created.ok && created.status !== 422) throw new Error('无法创建私人记录分支。');
    } else if (!reference.ok) throw new Error('私人记录分支无法读取。');
    try { storage().setItem(tokenKey, token); } catch { /* Memory-only connection. */ }
    return { authenticated: true, password_required: true };
  }

  async function staticJSON(path) {
    const response = await fetcher(`${base}/${path}`);
    if (!response.ok) throw new Error('学习资料暂时无法读取，请刷新后重试。');
    return response.json();
  }

  async function sessions(module) {
    const response = await github(`/git/trees/${branch}?recursive=1`);
    if (!response.ok) throw new Error('对话历史无法读取。');
    const tree = await response.json();
    if (tree.truncated) throw new Error('历史索引需要分片；没有删除任何历史记录。');
    const paths = tree.tree.filter(item => item.type === 'blob' && item.path.startsWith(`${prefix}/sessions/${module}/`) && item.path.endsWith('.json'));
    const records = [];
    for (let index = 0; index < paths.length; index += 8) {
      records.push(...await Promise.all(paths.slice(index, index + 8).map(item => read(item.path))));
    }
    return records.filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));
  }

  async function ask(body) {
    const path = sessionPath(config.module, body.session_id);
    const session = await read(path);
    if (!session) throw new Error('对话不存在；请重新选择资料。');
    let requestId = session.active_request_id;
    if (requestId) {
      const pending = await read(`${prefix}/requests/${requestId}.json`);
      if (!pending || pending.message !== body.message) throw new Error('这段对话有尚未结束的请求，请先等待或核查其状态。');
    } else {
      requestId = uuid();
      await write(path, { ...session, active_request_id: requestId });
      const requestPath = `${prefix}/requests/${requestId}.json`;
      await read(requestPath);
      await write(requestPath, { schema_version: '1.0.0', id: requestId, session_id: session.id,
        module: session.module, resource_id: session.resource_id, message: body.message,
        created: new Date().toISOString(), status: 'QUEUED' });
    }
    const requestPath = `${prefix}/requests/${requestId}.json`;
    const queued = await read(requestPath);
    if (queued.status === 'QUEUED') {
      const dispatch = await github('/actions/workflows/personal-qa.yml/dispatches', 'POST', { ref: 'main', inputs: { request_id: requestId } });
      if (!dispatch.ok) throw new Error('问题已保存，但 Actions 尚未启动。检查工作流和 Actions 写权限后重试。');
    }
    const status = document.getElementById('chat-status');
    if (status) status.textContent = '问题已存入私有仓库，正在等待 GitHub Actions 回复…';
    for (let attempt = 0; attempt < 180; attempt++) {
      const result = await read(requestPath);
      if (result.status === 'COMPLETED') return { reply: result.reply, context_ids: [session.resource_id] };
      if (['FAILED', 'UNKNOWN'].includes(result.status)) throw new Error('本次生成没有得到完整保存的回复。问题仍在仓库；请核查模型配置和 Actions 状态。');
      await sleep(5000);
    }
    throw new Error('请求仍在仓库，等待已结束。重新打开历史可查看结果；请勿重复提交相同问题。');
  }

  async function handle(path, options = {}) {
    const url = new URL(path, 'https://workspace.invalid');
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    const module = url.searchParams.get('module') || body.module || config.module;
    if (!modules.has(module)) return json({ detail: '未知模块。' }, 422);
    if (url.pathname === '/api/me') return json({ authenticated: Boolean(token), password_required: true });
    if (url.pathname === '/api/login') return json(await connect(body.password));
    if (url.pathname === '/api/logout') {
      token = null; cache.clear(); try { storage().removeItem(tokenKey); } catch { /* Already disconnected. */ }
      return json({ ok: true });
    }
    if (!token) return json({ detail: '请连接你的 GitHub 账号。' }, 401);
    if (url.pathname === '/api/catalog') return json(await staticJSON(`data/catalog-${module}.json`));
    const study = url.pathname.match(/^\/api\/reading\/([a-z0-9_-]+)\/study$/);
    if (study) return json(await staticJSON(`data/books/${study[1]}.json`));
    if (url.pathname === '/api/notes') {
      const resource = url.searchParams.get('resource_id') || body.resource_id;
      if (!identity(resource)) return json({ detail: '无效材料。' }, 422);
      const notePath = `${prefix}/notes/${module}/${resource}.json`;
      if (method === 'GET') return json(await read(notePath) || { answer: '' });
      if (!cache.has(notePath)) throw new Error('读取尚未成功；不能覆盖保存。');
      const previous = cache.get(notePath).data || { revisions: [] };
      const revision = { id: uuid(), answer: body.answer, created: new Date().toISOString() };
      const saved = await write(notePath, { schema_version: '1.0.0', answer: body.answer,
        revisions: [...(previous.revisions || []), revision] });
      await flushNavigation().catch(() => { /* Note is saved; resume remains local. */ });
      return json(saved);
    }
    if (url.pathname === '/api/sessions') {
      if (method === 'GET') return json(await sessions(module));
      const materials = await staticJSON(`data/catalog-${module}.json`);
      const item = materials.items.find(item => item.id === body.resource_id);
      if (!item) return json({ detail: '资料不在当前模块。' }, 422);
      const id = uuid(), path = sessionPath(module, id);
      await read(path);
      return json(await write(path, { schema_version: '1.0.0', id, module, resource_id: item.id,
        title: item.title, created: new Date().toISOString(), messages: [], active_request_id: null }));
    }
    const session = url.pathname.match(/^\/api\/sessions\/([a-f0-9]{32})$/);
    if (session) return json(await read(sessionPath(module, session[1])) || { detail: '对话不存在。' }, cache.get(sessionPath(module, session[1]))?.data ? 200 : 404);
    if (url.pathname === '/api/chat') return json(await ask(body));
    return json({ detail: '此部署没有这项操作。' }, 404);
  }
  return Object.freeze({ restoreNavigation, flushNavigation, rememberNavigation, request: async (...args) => {
    try { return await handle(...args); }
    catch (error) { if (error.status === 401) return json({ detail: error.message }, 401); throw error; }
  } });
};

if (window.HUB_GITHUB_CONFIG && !window.HUB_SHARED_CONFIG && window.HUB_GITHUB_CONFIG.transport !== 'shared') {
  window.HUB_REMOTE = window.HUB_GITHUB_TRANSPORT(window.HUB_GITHUB_CONFIG);
  document.addEventListener('DOMContentLoaded', () => {
    const label = document.querySelector('label[for=password]');
    if (label) label.textContent = 'GitHub 个人访问令牌';
    const input = document.getElementById('password');
    input.autocomplete = 'off'; input.placeholder = '仅授权此私有仓库的令牌';
    document.querySelector('.login-copy').textContent = '连接你的 GitHub 账号，读取并同步私有学习记录。令牌只保留在当前标签页。';
    const help = document.createElement('p');
    help.className = 'login-copy';
    help.append('首次连接：创建限期令牌，只选择 SuperIntelligence 仓库，授权 Contents 和 Actions 读写。');
    const link = document.createElement('a');
    const url = new URL('https://github.com/settings/personal-access-tokens/new');
    url.search = new URLSearchParams({ name: 'Personal learning workspace', target_name: window.HUB_GITHUB_CONFIG.owner,
      expires_in: '30', contents: 'write', actions: 'write' }).toString();
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = '在 GitHub 设置连接';
    help.append(' ', link);
    document.querySelector('.login-copy').after(help);
  });
}
