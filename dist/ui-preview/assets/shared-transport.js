/* Public materials stay static; only the shared gateway handles private state. */
window.HUB_SHARED_TRANSPORT = (config, dependencies = {}) => {
  const fetcher = dependencies.fetch || window.fetch.bind(window);
  const storage = dependencies.storage || (() => window.sessionStorage);
  const local = dependencies.localStorage || (() => window.localStorage);
  const clock = dependencies.now || (() => Date.now());
  const modules = new Set(['reading', 'learning', 'trading', 'investment']);
  const base = String(config.base || '').replace(/\/$/, '');
  const apiBase = String(config.apiBase || '').replace(/\/$/, '');
  const fallbackBase = String(config.apiFallbackOrigin || '').replace(/\/$/, '');
  if (fallbackBase && fallbackBase !== 'https://reading-workspace-api.zippybox2.chatgpt.site') {
    throw new Error('备用学习服务地址无效。');
  }
  const tokenKey = `hub-shared-session:${apiBase || 'unconfigured'}`;
  const rememberedKey = `${tokenKey}:remembered`;
  const cache = new Map();
  const responseVersions = new WeakMap();
  const pendingQuestions = new Map();
  const sessionResources = new Map();
  const activeQuestions = new Map();
  const studyPackets = new Map();
  const studyReads = new Map();
  const changedSections = new Map();
  let session = null, sessionRevision = 0, readOnly = false;
  let navigation = null, navigationDirty = false, navigationTimer, navigationRevision = 0;
  let navigationWrite = null;
  let selectedBase = null, routeSelection = null;
  let rememberDevice = false, sessionRefresh = null;
  const identity = value => typeof value === 'string' && /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value);
  const uuid = () => crypto.randomUUID().replaceAll('-', '');
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  function validAccess(value) {
    return value && typeof value.token === 'string' && value.token.length > 0
      && value.token.length <= 8192 && Number.isFinite(Date.parse(value.expires_at))
      && Date.parse(value.expires_at) > clock();
  }

  function validRefresh(value) {
    return value && typeof value.refresh_token === 'string' && value.refresh_token.length > 0
      && value.refresh_token.length <= 8192 && Number.isFinite(Date.parse(value.refresh_expires_at))
      && Date.parse(value.refresh_expires_at) > clock();
  }

  function validSession(value) { return validAccess(value) || validRefresh(value); }

  function persistSession() {
    try { storage().setItem(tokenKey, JSON.stringify(session)); } catch { /* Memory remains usable. */ }
    try {
      if (rememberDevice) local().setItem(rememberedKey, JSON.stringify(session));
      else local().removeItem(rememberedKey);
    } catch { /* Device persistence is optional. */ }
  }

  function sessionDate(value) {
    const date = new Date(typeof value === 'number' && Number.isSafeInteger(value) ? value * 1000
      : typeof value === 'string' ? value : NaN);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }

  function hasSession() { return !readOnly && validSession(session); }

  function forgetSession() {
    sessionRevision += 1;
    session = null;
    selectedBase = null;
    routeSelection = null;
    sessionRefresh = null;
    rememberDevice = false;
    cache.clear();
    sessionResources.clear();
    activeQuestions.clear();
    navigation = null;
    navigationDirty = false;
    changedSections.clear();
    clearTimeout(navigationTimer);
    try { storage().removeItem(tokenKey); } catch { /* Memory is already cleared. */ }
    try { local().removeItem(rememberedKey); } catch { /* Memory is already cleared. */ }
  }

  function setReadOnly(value) {
    if (typeof value !== 'boolean') throw new TypeError('Invalid public-reading state');
    readOnly = value;
    if (value) forgetSession();
  }

  let tabSnapshot, deviceSnapshot;
  try { tabSnapshot = storage().getItem(tokenKey); } catch { /* Device restoration can still work. */ }
  try { deviceSnapshot = local().getItem(rememberedKey); } catch { /* Current-tab restoration can still work. */ }
  for (const saved of [tabSnapshot, deviceSnapshot]) {
    if (!saved) continue;
    try {
      const value = JSON.parse(saved);
      if (validSession(value)) { session = value; rememberDevice = value.remember_device !== false; break; }
    } catch { /* A stale tab must not hide a valid remembered credential. */ }
  }
  if (!session && (tabSnapshot || deviceSnapshot)) forgetSession();
  if (session && rememberDevice) persistSession();

  function gatewayURL(path, endpoint = apiBase) {
    if (!apiBase) throw new Error('共享服务尚未配置，可以稍后再试。');
    const origin = new URL(endpoint);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)
        || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) {
      throw new Error('共享服务地址无效。');
    }
    if (!path.startsWith('/api/')) throw new Error('未知共享操作。');
    return `${endpoint}${path}`;
  }

  async function selectGateway(revision, excluded = null) {
    if (!fallbackBase) return apiBase;
    if (selectedBase && selectedBase !== excluded) return selectedBase;
    if (!routeSelection || excluded) {
      // Public capability probes contain no bearer, password, records or model request.
      const endpoints = [...new Set([apiBase, fallbackBase])].filter(value => value !== excluded);
      const retryable = new Set();
      const probe = (candidates, timeout) => Promise.any(candidates.map(async endpoint => {
        try {
          const response = await boundedFetch(gatewayURL('/api/release', endpoint), {
            method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json' },
          }, timeout, '连接学习服务超时，请检查网络后重试。', '无法连接学习服务，请检查网络后重试。');
          const release = await response.json();
          if ([502, 503, 504].includes(response.status)) {
            retryable.add(endpoint);
            throw new Error('学习服务暂未响应。');
          }
          if (!response.ok || release.packaged !== true || release.chat_packet_validation !== 'sha256-v1'
              || !/^[a-f0-9]{40}$/.test(release.source_commit || '')
              || !release.packets_sha256 || !Object.keys(release.packets_sha256).length) {
            throw new Error('学习服务尚未就绪。');
          }
          return endpoint;
        } catch (error) {
          if (error?.transportFailure) retryable.add(endpoint);
          throw error;
        }
      }));
      const pending = (async () => {
        try { return await probe(endpoints, 5000); }
        catch (error) {
          if (revision !== sessionRevision) throw new Error('会话已更新，请重试当前操作。');
          if (!retryable.size) throw error;
          // One recovery round for public probes only: total wait is at most 20s.
          // Invalid capability packets never become credential destinations.
          return probe([...retryable], 15000);
        }
      })();
      routeSelection = pending;
    }
    const pending = routeSelection;
    try {
      const endpoint = await pending;
      if (revision !== sessionRevision) throw new Error('会话已更新，请重试当前操作。');
      if (routeSelection === pending) selectedBase = endpoint;
      return endpoint;
    } catch (error) {
      if (error?.name === 'AggregateError') throw new Error('学习服务的连接暂时不可用。公开资料仍可阅读，未保存的内容请保留后重试。');
      throw error;
    } finally { if (routeSelection === pending) routeSelection = null; }
  }

  async function refreshAccess() {
    if (validAccess(session) && Date.parse(session.expires_at) - clock() > 300000) return;
    if (!validRefresh(session)) return;
    if (sessionRefresh) return sessionRefresh;
    const revision = sessionRevision, previous = session;
    const pending = (async () => {
      const response = await gateway('/api/session/refresh', 'POST', undefined, true, previous.refresh_token);
      if (revision !== sessionRevision) throw new Error('会话已更新，请重新读取记录。');
      if (response.status === 401) { forgetSession(); return; }
      if (!response.ok) throw new Error('登录续期暂未完成，请稍后重试；草稿已保留。');
      const result = await response.json();
      const updated = { ...previous, token: result.token, expires_at: sessionDate(result.expires_at) };
      if (!result.authenticated || !validAccess(updated)) throw new Error('登录续期未完成，请稍后重试。');
      if (revision !== sessionRevision) throw new Error('会话已更新，请重新读取记录。');
      session = updated;
      persistSession();
    })();
    sessionRefresh = pending;
    try { await pending; } finally { if (sessionRefresh === pending) sessionRefresh = null; }
  }

  async function gateway(path, method = 'GET', body, unauthenticated = false, bearer = null) {
    gatewayURL(path);
    const revision = sessionRevision;
    if (!unauthenticated && readOnly) return json({ detail: '请连接记录后使用此操作。' }, 401);
    if (!unauthenticated && validRefresh(session)
        && (!validAccess(session) || Date.parse(session.expires_at) - clock() <= 300000)) {
      await refreshAccess();
      if (revision !== sessionRevision) throw new Error('会话已更新，请重新读取记录。');
    }
    if (!unauthenticated && !validSession(session)) {
      forgetSession();
      return json({ detail: '请重新输入用户名。' }, 401);
    }
    let endpoint = fallbackBase ? await selectGateway(revision) : apiBase;
    if (revision !== sessionRevision) throw new Error('会话已更新，请重试当前操作。');
    const timeoutMs = path === '/api/login' ? 12000
      : path.startsWith('/api/chat') || path === '/api/organization' && method === 'POST' ? 240000 : 60000;
    const timeoutMessage = path === '/api/login'
      ? '连接验证服务超时，请检查网络后重试。'
      : '连接学习服务超时，请检查网络后重试。';
    const send = origin => boundedFetch(gatewayURL(path, origin), {
      method, credentials: 'omit', cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(bearer || !unauthenticated && session ? { Authorization: `Bearer ${bearer || session.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Hub-Request': '1' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }, timeoutMs, timeoutMessage, '无法连接学习服务，请检查网络后重试。');
    let response;
    try { response = await send(endpoint); }
    catch (error) {
      if (!fallbackBase || !error?.transportFailure || revision !== sessionRevision) throw error;
      selectedBase = null;
      // Login is stateless; GET is read-only. Never replay a write or billed POST.
      if (method !== 'GET' && !['/api/login', '/api/session/refresh'].includes(path)) throw error;
      endpoint = await selectGateway(revision, endpoint);
      if (revision !== sessionRevision) throw new Error('会话已更新，请重试当前操作。');
      response = await send(endpoint);
    }
    if (!unauthenticated && revision !== sessionRevision) throw new Error('会话已更新，请重试当前操作。');
    if (response.status === 401 && !unauthenticated) forgetSession();
    responseVersions.set(response, revision);
    return response;
  }

  async function boundedFetch(target, settings, timeoutMs, timeoutMessage, networkMessage) {
    const controller = new AbortController();
    let timer, expired = false;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([deadline, (async () => {
        const reply = await fetcher(target, {
          ...settings,
          signal: controller.signal,
        });
        // Cover a stalled response body as well as the connection, preserving
        // the original response for the existing JSON/version checks.
        await reply.clone().json();
        return reply;
      })()]);
      return response;
    } catch (error) {
      if (expired || error instanceof TypeError) {
        const failure = new Error(expired ? timeoutMessage : networkMessage);
        failure.transportFailure = true;
        throw failure;
      }
      if (error?.name === 'SyntaxError') throw new Error('服务回复传输未完成，请稍后重试当前操作。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function capture(response, key) {
    if (response.ok) {
      const revision = responseVersions.get(response);
      requireConnection(revision);
      const data = await response.clone().json();
      requireConnection(revision);
      if (!Object.prototype.hasOwnProperty.call(data, 'sha')) {
        throw new Error('共享记录缺少版本信息，暂时不能覆盖保存。');
      }
      cache.set(key, data.sha);
      if (key.startsWith('session:')) {
        if (identity(data.resource_id)) sessionResources.set(key, data.resource_id);
        if (typeof data.active_request_id === 'string' && /^[a-f0-9]{32}$/.test(data.active_request_id)) {
          activeQuestions.set(key, data.active_request_id);
        } else activeQuestions.delete(key);
      }
    }
    return response;
  }

  function requireConnection(revision) {
    if (readOnly || revision === undefined || revision !== sessionRevision || !validSession(session)) {
      throw new Error('会话已更新，请重新读取记录。');
    }
  }

  async function staticJSON(path) {
    const revision = (studyReads.get(path) || 0) + 1;
    studyReads.set(path, revision);
    const response = await boundedFetch(`${base}/${path}`, {
      cache: 'no-cache', credentials: 'omit', headers: { Accept: 'application/json' },
    }, 20000, '读取学习资料超时，请检查网络后重试。', '无法读取学习资料，请检查网络后重试。');
    if (!response.ok) throw new Error('学习资料暂时无法读取，请刷新后重试。');
    const bytes = await response.clone().arrayBuffer();
    const data = await response.json();
    if (studyReads.get(path) !== revision) {
      throw new Error('资料读取已更新，请使用最新版本。');
    }
    studyPackets.set(path, { bytes, data });
    return data;
  }

  async function chatPackets(module, resource) {
    const revision = sessionRevision;
    if (!identity(resource)) throw new Error('请重新读取所选对话和学习资料。');
    const catalogPath = `data/catalog-${module}.json`;
    if (!studyPackets.has(catalogPath)) await staticJSON(catalogPath);
    const material = studyPackets.get(catalogPath).data.items?.find(item => item.id === resource);
    if (!material) throw new Error('当前资料版本中没有这份材料，请刷新后再提交问题。');
    const paths = [catalogPath];
    if (module === 'reading' && material.kind === 'book') {
      const bookPath = `data/books/${resource}.json`;
      if (!studyPackets.has(bookPath)) await staticJSON(bookPath);
      paths.push(bookPath);
    }
    if (!crypto.subtle) throw new Error('浏览器无法完成资料版本校验，请刷新或更换浏览器后重试。');
    const expected = {};
    const snapshots = new Map();
    for (const path of paths) {
      const packet = studyPackets.get(path);
      snapshots.set(path, packet);
      packet.sha ||= [...new Uint8Array(await crypto.subtle.digest('SHA-256', packet.bytes))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      expected[path] = packet.sha;
    }
    const response = await gateway('/api/release');
    requireConnection(revision);
    if (!response.ok) throw new Error('资料版本校验暂未完成，问题已保留，请稍后再试。');
    const release = await response.json();
    requireConnection(revision);
    if (paths.some(path => studyPackets.get(path) !== snapshots.get(path))) {
      throw new Error('资料版本已更新，问题已保留，请重新核对后再提交。');
    }
    if (release.packaged !== true || release.chat_packet_validation !== 'sha256-v1') {
      throw new Error('学习服务暂时无法核对资料版本，问题已保留，请稍后再试。');
    }
    if (paths.some(path => release.packets_sha256?.[path] !== expected[path])) {
      throw new Error('网页与后台的资料版本尚未一致，问题已保留，请刷新后再试。');
    }
    return expected;
  }

  function noteKey(module, resource) { return `note:${module}:${resource}`; }
  function sessionKey(module, id) { return `session:${module}:${id}`; }
  function preferencesKey(module) { return `preferences:${module}`; }

  function expectedSHA(key) {
    if (!cache.has(key)) throw new Error('请先成功读取记录，再保存修改。');
    return cache.get(key);
  }

  async function restoreNavigation() {
    // A concurrent browser update must not replace a locally pending position.
    if (readOnly || navigationDirty) return;
    const revision = sessionRevision;
    const positionRevision = navigationRevision;
    const response = await gateway(`/api/preferences?module=${encodeURIComponent(config.module)}`);
    if (!response.ok) throw new Error('阅读位置暂时无法同步。');
    const record = await response.json();
    requireConnection(revision);
    // Apply values and their SHA together. A skipped refresh must not provide
    // a new write baseline for the older local sections.
    if (positionRevision !== navigationRevision) return;
    if (!record.sections || typeof record.sections !== 'object' || Array.isArray(record.sections)) {
      throw new Error('阅读位置记录格式无效。');
    }
    if (!Object.prototype.hasOwnProperty.call(record, 'sha')) throw new Error('共享记录缺少版本信息，暂时不能覆盖保存。');
    cache.set(preferencesKey(config.module), record.sha);
    navigation = { last_resource_id: record.last_resource_id || null, sections: { ...record.sections } };
    try {
      const lastKey = `hub-last-material-v1:${config.module}`;
      if (identity(navigation.last_resource_id)) local().setItem(lastKey, navigation.last_resource_id);
      else local().removeItem(lastKey);
      const sectionPrefix = `hub-section-v1:${config.module}:`;
      const stale = [];
      for (let index = 0; index < local().length; index++) {
        const key = local().key(index);
        if (key?.startsWith(sectionPrefix)) stale.push(key);
      }
      stale.forEach(key => local().removeItem(key));
      for (const [resource, section] of Object.entries(navigation.sections)) {
        if (identity(resource) && typeof section === 'string' && section.length <= 500) {
          local().setItem(`${sectionPrefix}${resource}`, section);
        }
      }
    } catch { /* Reading remains available without optional browser preferences. */ }
  }

  async function flushNavigation() {
    clearTimeout(navigationTimer);
    if (readOnly) return;
    if (navigationWrite) return navigationWrite;
    if (!navigationDirty || !navigation) return;
    const revision = navigationRevision, connectionRevision = sessionRevision;
    const snapshot = { module: config.module, last_resource_id: navigation.last_resource_id,
      sections: { ...navigation.sections }, expected_sha: expectedSHA(preferencesKey(config.module)) };
    const edits = new Map(changedSections);
    navigationWrite = (async () => {
      let written = snapshot;
      let response = await gateway('/api/preferences', 'PUT', written);
      requireConnection(connectionRevision);
      if (response.status === 409) {
        // Positions are navigation metadata. Preserve the other visitor's
        // untouched sections while merging only this browser's recent moves.
        const latestResponse = await gateway(`/api/preferences?module=${encodeURIComponent(config.module)}`);
        requireConnection(connectionRevision);
        if (!latestResponse.ok) throw new Error('阅读位置暂未同步。');
        await capture(latestResponse, preferencesKey(config.module));
        const latest = await latestResponse.json();
        requireConnection(connectionRevision);
        if (!latest.sections || typeof latest.sections !== 'object' || Array.isArray(latest.sections)) {
          throw new Error('阅读位置记录格式无效。');
        }
        const merged = { ...latest.sections };
        for (const [resource, edit] of edits) merged[resource] = edit.section;
        written = { ...snapshot, sections: merged, expected_sha: latest.sha };
        requireConnection(connectionRevision);
        response = await gateway('/api/preferences', 'PUT', written);
      }
      if (!response.ok) throw new Error(response.status === 409
        ? '阅读位置在别处更新；当前浏览器保留你的位置。' : '阅读位置暂未同步。');
      await capture(response, preferencesKey(config.module));
      if (readOnly || connectionRevision !== sessionRevision) return;
      const newer = [...changedSections].filter(([, edit]) => edit.revision > revision);
      navigation.sections = { ...written.sections };
      for (const [resource, edit] of newer) navigation.sections[resource] = edit.section;
      for (const [resource, edit] of changedSections) {
        if (edit.revision <= revision) changedSections.delete(resource);
      }
      if (revision === navigationRevision) navigationDirty = false;
    })();
    try { await navigationWrite; }
    finally {
      navigationWrite = null;
      if (!readOnly && navigationDirty && revision !== navigationRevision) scheduleNavigation();
    }
  }

  function scheduleNavigation() {
    if (readOnly) return;
    clearTimeout(navigationTimer);
    navigationTimer = setTimeout(() => flushNavigation().catch(() => {
      const status = document.getElementById('resume-status');
      if (status) { status.hidden = false; status.textContent = '位置暂未同步'; }
    }), 20000);
  }

  function rememberNavigation(module, resource, section) {
    if (readOnly || !navigation || module !== config.module || !identity(resource)) return;
    navigation.last_resource_id = resource;
    navigationDirty = true;
    navigationRevision++;
    if (typeof section === 'string' && section.length <= 500) {
      navigation.sections[resource] = section;
      changedSections.set(resource, { section, revision: navigationRevision });
    }
    scheduleNavigation();
  }

  async function handle(path, options = {}) {
    const url = new URL(path, 'https://workspace.invalid');
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : undefined;
    const module = url.searchParams.get('module') || body?.module || config.module;
    if (!modules.has(module)) return json({ detail: '未知模块。' }, 422);
    // These files are already anonymous, allowlisted GitHub Pages artifacts.
    // Shared records and model calls still require the gateway session below.
    if (method === 'GET' && url.pathname === '/api/catalog') {
      return json(await staticJSON(`data/catalog-${module}.json`));
    }
    const study = url.pathname.match(/^\/api\/reading\/([a-z0-9_-]+)\/study$/);
    if (method === 'GET' && study) return json(await staticJSON(`data/books/${study[1]}.json`));
    if (url.pathname === '/api/me') {
      if (readOnly) return json({ authenticated: false, password_required: true });
      if (!validSession(session)) { forgetSession(); return json({ authenticated: false, password_required: true }); }
      return gateway('/api/me');
    }
    if (url.pathname === '/api/login') {
      forgetSession();
      const revision = sessionRevision;
      const response = await gateway('/api/login', 'POST', { password: body?.password }, true);
      if (!response.ok) return response;
      const connected = await response.clone().json();
      // The gateway returns Unix seconds; current-tab storage uses an ISO date.
      const authenticatedSession = { token: connected.token,
        expires_at: sessionDate(connected.expires_at),
        ...(connected.refresh_token ? { refresh_token: connected.refresh_token,
          refresh_expires_at: sessionDate(connected.refresh_expires_at) } : {}),
        remember_device: body?.remember_device !== false };
      if (revision !== sessionRevision) throw new Error('登录请求已取消，请重试。');
      if (!connected.authenticated || !validSession(authenticatedSession)) throw new Error('登录未完成，请重新输入用户名。');
      session = authenticatedSession;
      rememberDevice = authenticatedSession.remember_device;
      persistSession();
      return response;
    }
    if (url.pathname === '/api/logout') {
      const revision = sessionRevision;
      let response;
      try { response = !readOnly && validSession(session) ? await gateway('/api/logout', 'POST', {}) : json({ ok: true }); }
      catch (error) {
        if (revision !== sessionRevision) throw error;
        response = json({ ok: true });
      }
      finally { if (revision === sessionRevision) forgetSession(); }
      return response;
    }
    if (readOnly) return json({ detail: '请连接记录后使用此操作。' }, 401);
    if (url.pathname === '/api/discussion-models' && method === 'GET') return gateway(url.pathname);
    if (url.pathname === '/api/organization' && ['GET', 'POST'].includes(method)) {
      return gateway(url.pathname + url.search, method, body);
    }
    if (url.pathname === '/api/organization-index' && method === 'GET') return gateway(url.pathname + url.search);
    if (!validSession(session)) { forgetSession(); return json({ detail: '请重新输入用户名。' }, 401); }
    if (url.pathname === '/api/annotations') {
      const resource = url.searchParams.get('resource_id') || body?.resource_id;
      if (!identity(resource)) return json({ detail: '无效材料。' }, 422);
      const key = `annotations:${module}:${resource}`;
      if (method === 'GET') return capture(await gateway(url.pathname + url.search), key);
      if (!['PUT', 'DELETE'].includes(method)) return json({ detail: '未知笔记操作。' }, 405);
      return capture(await gateway('/api/annotations', method, {
        ...body, module, resource_id: resource, expected_sha: expectedSHA(key),
      }), key);
    }
    if (url.pathname === '/api/notes') {
      const resource = url.searchParams.get('resource_id') || body?.resource_id;
      if (!identity(resource)) return json({ detail: '无效材料。' }, 422);
      const key = noteKey(module, resource);
      if (method === 'GET') {
        const response = await gateway(url.pathname + url.search);
        return options.preserveVersion ? response : capture(response, key);
      }
      const response = await capture(await gateway('/api/notes', 'PUT', {
        ...body, module, resource_id: resource, expected_sha: expectedSHA(key),
      }), key);
      if (response.ok) await flushNavigation().catch(() => { /* Notes are saved; navigation remains local. */ });
      return response;
    }
    if (url.pathname === '/api/sessions') {
      if (method === 'GET') return gateway(`/api/sessions?module=${encodeURIComponent(module)}`);
      const response = await gateway('/api/sessions', 'POST', { ...body, module });
      if (response.ok) {
        const created = await response.clone().json();
        await capture(response, sessionKey(module, created.id));
        if (identity(created.resource_id || body?.resource_id)) {
          sessionResources.set(sessionKey(module, created.id), created.resource_id || body.resource_id);
        }
      }
      return response;
    }
    const conversation = url.pathname.match(/^\/api\/sessions\/([a-f0-9]{32})$/);
    if (conversation) {
      const key = sessionKey(module, conversation[1]);
      if (method === 'GET') return capture(await gateway(`${url.pathname}?module=${encodeURIComponent(module)}`), key);
      if (method !== 'DELETE') return json({ detail: '未知对话操作。' }, 405);
      // The list's authoritative SHA binds the exact conversation the user chose.
      // Never refresh the baseline silently or replay a deletion after uncertainty.
      if (typeof body?.expected_sha !== 'string' || !body.expected_sha) {
        return json({ detail: '对话缺少版本信息，请刷新历史列表后重试。' }, 409);
      }
      const response = await gateway(url.pathname, 'DELETE', { module, expected_sha: body.expected_sha });
      if (response.ok) { cache.delete(key); sessionResources.delete(key); activeQuestions.delete(key); }
      return response;
    }
    if (url.pathname === '/api/chat') {
      const key = sessionKey(module, body?.session_id);
      if (!cache.has(key)) {
        const latest = await gateway(`/api/sessions/${body.session_id}?module=${encodeURIComponent(module)}`);
        if (!latest.ok) return latest;
        await capture(latest, key);
      }
      const resource = body?.resource_id || sessionResources.get(key);
      const questionKey = JSON.stringify([module, body?.session_id, body?.message]);
      let requestId = pendingQuestions.get(questionKey);
      let durable = false;
      const recovering = requestId || activeQuestions.get(key);
      if (recovering) {
        // A new tab can recover a queued/answered reservation only when the
        // user explicitly submits that exact question. A lost completed reply
        // keeps its pending ID even after the server cleared its reservation.
        const revision = sessionRevision;
        const stored = await gateway(`/api/requests/${recovering}`);
        if (!stored.ok && stored.status !== 404) return stored;
        // Reservations precede initial request persistence. An interrupted
        // queue write has no request/generation yet; retain the reserved ID.
        if (stored.status === 404) {
          requireConnection(revision);
          requestId = recovering;
          pendingQuestions.set(questionKey, requestId);
        } else {
          const request = await stored.json();
          requireConnection(revision);
          if (request.id !== recovering || request.module !== module || request.session_id !== body?.session_id
              || request.resource_id !== resource) throw new Error('已有请求与所选对话不一致，问题已保留。');
          if (request.message !== body?.message) return json({ detail: '这段对话还有未完成的问题，新问题已保留。' }, 409);
          if (request.generation_intent && (body?.model || body?.reasoning_effort)
              && (request.generation_intent.model !== body.model
                  || request.generation_intent.reasoning_effort !== body.reasoning_effort)) {
            return json({ detail: '这条问题已有固定模型和思考深度，请恢复原设置后读取结果。' }, 409);
          }
          requestId = recovering;
          pendingQuestions.set(questionKey, requestId);
          if (['RUNNING', 'UNKNOWN'].includes(request.status) || (request.status === 'FAILED' && !request.failure_code)) {
            return json({ detail: '该请求结果尚未核实。问题已保留，不会自动再次计费。' }, 409);
          }
          if (!['QUEUED', 'ANSWERED', 'COMPLETED', 'FAILED'].includes(request.status)) {
            throw new Error('已有请求状态无法核实，问题已保留。');
          }
          durable = request.status !== 'QUEUED';
        }
      }
      const expectedPackets = durable ? undefined : await chatPackets(module, resource);
      if (!requestId) { requestId = uuid(); pendingQuestions.set(questionKey, requestId); }
      const response = await gateway('/api/chat', 'POST', {
        ...body, module, request_id: requestId, expected_sha: expectedSHA(key),
        expected_packets_sha256: expectedPackets,
      });
      if (!response.ok) {
        const failure = await response.clone().json().catch(() => null);
        if (failure?.request_status === 'FAILED' && failure.retry_after_configuration === true) {
          // A provider explicitly refused generation. Only a later user click
          // creates a new attempt; ambiguous requests retain their original ID.
          pendingQuestions.delete(questionKey);
          cache.delete(key);
        }
      }
      if (response.ok) {
        const result = await response.clone().json();
        if (result.status !== 'COMPLETED' || typeof result.reply !== 'string' || !result.reply.trim()) {
          throw new Error('本次请求没有得到完整回复，问题已保留。');
        }
        pendingQuestions.delete(questionKey);
        // History changed on the server. Refresh it before a later chat write.
        cache.delete(key);
        try {
          const latest = await gateway(`/api/sessions/${body.session_id}?module=${encodeURIComponent(module)}`);
          if (latest.ok) await capture(latest, key);
        } catch { /* A saved reply remains completed; read again before the next question. */ }
      }
      return response;
    }
    return json({ detail: '此部署没有这项操作。' }, 404);
  }

  function acceptNoteSnapshot(module, resource, record) {
    requireConnection(sessionRevision);
    if (!modules.has(module) || !identity(resource) || !record
        || !Object.prototype.hasOwnProperty.call(record, 'sha')) {
      throw new Error('共享记录缺少版本信息，暂时不能覆盖保存。');
    }
    cache.set(noteKey(module, resource), record.sha);
  }

  return Object.freeze({ kind: 'shared', hasSession, setReadOnly, restoreNavigation, flushNavigation, rememberNavigation, acceptNoteSnapshot,
    request: handle });
};

const sharedHubConfig = window.HUB_SHARED_CONFIG
  || (window.HUB_GITHUB_CONFIG?.transport === 'shared' ? window.HUB_GITHUB_CONFIG : null);
if (sharedHubConfig) {
  window.HUB_REMOTE = window.HUB_SHARED_TRANSPORT(sharedHubConfig);
  document.addEventListener('DOMContentLoaded', () => {
    const label = document.querySelector('label[for=password]');
    if (label) label.textContent = '用户名';
    const input = document.getElementById('password');
    if (input) { input.autocomplete = 'username'; input.placeholder = '输入用户名'; }
    const badge = document.querySelector('.private-badge');
    if (badge) badge.textContent = '共享保存';
  });
}
