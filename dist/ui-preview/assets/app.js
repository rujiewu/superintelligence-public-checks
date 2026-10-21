(function () {
  "use strict";

  const MODULES = window.HUB_MODULES;

  const state = {
    module: moduleFromPath(),
    items: [],
    selectedId: null,
    sessions: [],
    sessionId: null,
    sessionResourceId: null,
    sending: false,
    deletingSession: null,
    loadingResourceToken: 0,
    sessionLoadToken: 0,
    chatRequestToken: 0,
    noteBaseline: "",
    noteReady: false,
    savingNote: false,
    studySections: [],
    detailView: "text",
    detailScroll: {},
    bookStudy: null,
    bookPage: "lecture",
    bookLoadToken: 0,
    positionReady: false,
    refreshingShared: false,
    readOnly: false,
    authRequestToken: 0,
    workspaceLoadToken: 0,
    modeRevision: 0,
    selectionRequestToken: 0,
    noteSHA: undefined,
    preservedNoteDraft: false,
    noteEditRevision: 0,
    noteSaveToken: 0,
    noteSyncFailed: false,
    noteComposing: false,
    publicChatDraft: null,
    discussionModels: [],
    discussionReady: false,
    catalogScope: "",
    catalogBrowsing: false,
  };

  const elements = {};
  let toastTimer;
  let studyNavigation;
  let workspaceState;
  let readingNotes;
  let organizer;
  let noteSaveTimer;
  const NOTE_SAVE_DELAY = 2500;

  class AuthRequiredError extends Error {}

  document.addEventListener("DOMContentLoaded", start);

  function start() {
    document.documentElement.dataset.input = "pointer";
    collectElements();
    workspaceState = window.HUB_WORKSPACE_STATE(() => window.localStorage);
    const connected = () => !state.readOnly && !elements['app-shell'].hidden
      && (window.HUB_REMOTE?.kind !== 'shared' || window.HUB_REMOTE.hasSession());
    organizer = window.HUB_ORGANIZER({ api, connected });
    readingNotes = window.HUB_ANNOTATIONS?.({ api, notify, connected, organizer });
    studyNavigation = window.HUB_STUDY_NAVIGATION(document.getElementById("resource-detail"),
      elements["study-section"], document.querySelector(".detail-navigation"), document.getElementById("study-position"),
      value => {
        if (!state.readOnly && state.positionReady && state.detailView === "text") {
          const key = readingSectionKey(value);
          if (key) workspaceState.rememberSection(state.module, state.selectedId, key);
        }
      });
    configureTheme();
    setFocus(workspaceState.focus(), false);
    configureModule();
    bindEvents();
    setDiscussion(false);
    setPane("read");
    if (window.HUB_REMOTE?.kind === "shared" && new URLSearchParams(location.search).get("read") === "public") {
      enterPublicReading();
    } else checkAuthentication();
  }

  function collectElements() {
    [
      "boot-view", "login-view", "login-form", "password", "login-submit", "login-error",
      "app-shell", "logout", "theme-toggle", "module-eyebrow", "library-title", "resource-search",
      "resource-count", "catalog-status", "resource-list", "detail-empty", "detail-content",
      "detail-title", "detail-placement", "detail-subtitle", "detail-body", "links-section",
      "resource-links", "exercise-panel", "exercise-prompt", "note-answer", "note-status",
      "save-note", "new-session", "chat-context", "history-drawer", "session-count",
      "session-list", "chat-messages", "chat-form", "chat-input", "chat-status",
      "chat-send", "model-meta", "toast",
      "catalog-location", "catalog-scope", "catalog-topics", "text-section",
      "practice-guide", "insert-worksheet", "discuss-note",
      "study-section", "catalog-picker",
      "discussion-options", "discussion-model", "discussion-effort",
      "book-reading-modes",
      "focus-toggle", "resume-status",
      "record-status", "answer-tools", "resource-content", "content-filter",
      "discussion-toggle", "discussion-close",
      "notes-toggle", "notes-close", "notes-panel", "note-organization", "note-organization-retry",
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
  }

  function configureModule() {
    const config = MODULES[state.module];
    elements["module-eyebrow"].textContent = config.eyebrow;
    elements["library-title"].textContent = config.title;
    const choices = window.HUB_STUDY.catalogChoices(state.module);
    elements["resource-content"].replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
    elements["content-filter"].hidden = choices.length < 2;
    document.title = `${config.title} · SuperIntelligence`;

    document.querySelectorAll("[data-module]").forEach((link) => {
      const active = link.dataset.module === state.module;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
    });
  }

  function configureTheme() {
    let theme = "";
    try {
      theme = window.localStorage.getItem("hub-theme") || "";
    } catch (error) {
      theme = "";
    }
    if (theme !== "light" && theme !== "dark") {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    applyTheme(theme);
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      window.localStorage.setItem("hub-theme", next);
    } catch (error) {
      // Theme persistence is optional; no private content is stored in the browser.
    }
  }

  function applyTheme(theme) {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    elements["theme-toggle"].textContent = dark ? "浅色" : "深色";
    elements["theme-toggle"].setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
    elements["theme-toggle"].setAttribute("aria-pressed", String(dark));
  }

  function bindEvents() {
    window.addEventListener('hub-book-page', event => {
      if (!state.bookStudy || state.bookStudy.book_id !== state.selectedId) return;
      state.bookPage = event.detail.page;
      elements['book-reading-modes'].querySelectorAll('[data-book-page]').forEach(button => {
        const active = button.dataset.bookPage === state.bookPage;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        button.disabled = false;
      });
      document.getElementById('book-study').setAttribute('aria-labelledby', `book-page-${state.bookPage}`);
      configureBookSections();
    });
    elements['book-reading-modes'].addEventListener('click', event => {
      const button = event.target.closest('[data-book-page]');
      if (button) setBookPage(button.dataset.bookPage);
    });
    elements['book-reading-modes'].addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...elements['book-reading-modes'].querySelectorAll('[data-book-page]')];
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1
        : (buttons.indexOf(document.activeElement) + (event.key === 'ArrowRight' ? 1 : -1) + 2) % 2;
      buttons[index].focus({ preventScroll: true });
      setBookPage(buttons[index].dataset.bookPage);
    });
    window.addEventListener('hub-annotation-open', () => {
      setNotes(true);
      if (!window.matchMedia("(min-width: 1181px)").matches) setPane('notes');
    });
    window.addEventListener('hub-annotation-jump', () => { setDetailView('text'); setPane('read'); });
    document.addEventListener("pointerdown", () => { document.documentElement.dataset.input = "pointer"; }, { capture: true });
    document.addEventListener("keydown", event => {
      if (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        document.documentElement.dataset.input = "keyboard";
      }
    }, { capture: true });
    elements["login-form"].addEventListener("submit", login);
    elements.logout.addEventListener("click", () => state.readOnly ? showLogin() : logout());
    elements["theme-toggle"].addEventListener("click", toggleTheme);
    elements["discussion-toggle"].addEventListener("click", () => {
      setDiscussion(document.documentElement.dataset.discussion !== "true");
    });
    elements["notes-toggle"].addEventListener("click", () => {
      setNotes(document.documentElement.dataset.notes !== "true");
    });
    elements["notes-close"].addEventListener("click", () => {
      setNotes(false);
      if (window.matchMedia("(min-width: 1181px)").matches) elements["notes-toggle"].focus();
      else document.querySelector('button[data-pane="read"]').focus();
    });
    elements["discussion-close"].addEventListener("click", () => {
      setDiscussion(false);
      if (window.matchMedia("(min-width: 1181px)").matches) elements["discussion-toggle"].focus();
      else document.querySelector('button[data-pane="read"]').focus();
    });
    elements["focus-toggle"].addEventListener("click", () => {
      setFocus(document.documentElement.dataset.focus !== "true");
    });
    elements["resource-search"].addEventListener("input", () => {
      state.catalogBrowsing = false;
      renderResourceList();
    });
    elements["catalog-location"].addEventListener("click", event => {
      setCatalogPicker(!state.catalogBrowsing, event.detail === 0);
    });
    elements["catalog-location"].addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCatalogPicker(false);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        setCatalogPicker(true);
        const buttons = [...elements["catalog-topics"].querySelectorAll("button")];
        focusCatalogTopic(event.key === "End" || event.key === "ArrowUp" ? buttons.at(-1) : buttons[0]);
      }
    });
    elements["catalog-topics"].addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCatalogPicker(false);
        elements["catalog-location"].focus({ preventScroll: true });
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const buttons = [...elements["catalog-topics"].querySelectorAll("button")];
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        if (buttons[next]) { event.preventDefault(); focusCatalogTopic(buttons[next]); }
      }
    });
    window.addEventListener("resize", () => {
      if (state.catalogBrowsing) positionCatalogPicker();
    });
    document.addEventListener("pointerdown", event => {
      if (!elements["catalog-picker"].contains(event.target)) setCatalogPicker(false, false);
    });
    elements["catalog-picker"].addEventListener("focusout", event => {
      if (event.relatedTarget && !elements["catalog-picker"].contains(event.relatedTarget)) setCatalogPicker(false, false);
    });
    elements["resource-content"].addEventListener("change", () => {
      const available = state.items.filter(item => window.HUB_STUDY.catalogMatches(item, state.module, elements["resource-content"].value));
      if (!available.some(item => catalogOutline(item).groupKey === state.catalogScope)) state.catalogScope = "";
      renderResourceList();
    });
    elements["study-section"].addEventListener("change", () => {
      if (elements["study-section"].value === "extensions") {
        jumpTo("links-title");
        if (!state.readOnly && state.positionReady) workspaceState.rememberSection(state.module, state.selectedId, "extensions");
      }
      else selectStudy(Number(elements["study-section"].value));
    });
    elements["text-section"].addEventListener("click", event => {
      const link = event.target.closest('a[href^="#"]');
      if (!link || !document.getElementById(link.hash.slice(1))) return;
      event.preventDefault();
      jumpTo(link.hash.slice(1));
    });
    document.querySelectorAll("button[data-pane]").forEach(button => {
      button.addEventListener("click", () => setPane(button.dataset.pane));
    });
    elements["resource-list"].addEventListener("click", (event) => {
      const button = event.target.closest("[data-resource-id]");
      if (button) {
        selectResource(button.dataset.resourceId, { updateUrl: true });
        setPane("read");
      }
    });
    elements["resource-list"].addEventListener("keydown", navigateResourceList);
    elements["save-note"].addEventListener("click", () => saveNote());
    elements["insert-worksheet"].addEventListener("click", insertWorksheet);
    elements["discuss-note"].addEventListener("click", prepareNoteDiscussion);
    elements["note-answer"].addEventListener("input", noteChanged);
    elements["note-answer"].addEventListener("compositionstart", () => {
      state.noteComposing = true;
      clearNoteSaveTimer();
    });
    elements["note-answer"].addEventListener("compositionend", () => {
      state.noteComposing = false;
      noteChanged();
    });
    window.addEventListener("beforeunload", event => {
      if (!noteIsDirty() && !state.savingNote && !readingNotes?.isDirty() && !readingNotes?.isSaving()) return;
      event.preventDefault();
      event.returnValue = "";
    });
    elements["new-session"].addEventListener("click", startNewConversation);
    elements["session-list"].addEventListener("click", (event) => {
      const remove = event.target.closest('[data-delete-session]');
      if (remove) { deleteConversation(remove.dataset.deleteSession); return; }
      const button = event.target.closest("[data-session-id]");
      if (button) loadSession(button.dataset.sessionId);
    });
    elements["discussion-model"].addEventListener("change", () => { configureEfforts(); rememberDiscussionChoice(); });
    elements["discussion-effort"].addEventListener("change", rememberDiscussionChoice);
    elements["chat-form"].addEventListener("submit", sendMessage);
    elements["chat-input"].addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        elements["chat-form"].requestSubmit();
      }
    });
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPane("catalog");
        elements["resource-search"].focus();
      }
    });
    if (window.HUB_REMOTE?.kind === "shared") {
      window.addEventListener("focus", refreshSharedState);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshSharedState();
        else if (canAutoSaveNote()) saveNote({ automatic: true });
      });
      window.setInterval(() => {
        if (document.visibilityState === "visible") refreshSharedState();
      }, 60000);
    }
  }

  async function checkAuthentication() {
    const token = ++state.authRequestToken;
    if (window.HUB_REMOTE?.kind === "shared") {
      if (window.HUB_REMOTE.hasSession?.()) {
        showApp();
        elements["record-status"].textContent = "正在连接记录…";
        disableComposer(true);
      } else showLogin();
    }
    try {
      const me = await api("/api/me", { allowUnauthenticated: true });
      if (token !== state.authRequestToken || state.readOnly) return;
      elements.logout.hidden = !me.password_required;
      if (me && me.authenticated) {
        elements["record-status"].textContent = "学习空间";
        showApp();
        await loadWorkspace();
      } else {
        showLogin();
      }
    } catch (error) {
      if (token !== state.authRequestToken || state.readOnly) return;
      if (window.HUB_REMOTE?.kind === "shared") {
        showLogin(error.message || "暂时无法连接，请稍后重试。");
        return;
      }
      showApp();
      renderWorkspaceError("暂时无法连接工作台，请刷新后重试。");
    }
  }

  async function login(event) {
    event.preventDefault();
    const password = elements.password.value;
    if (!password || elements["login-submit"].disabled) return;
    pauseNoteSaving();
    const token = ++state.authRequestToken;
    const selection = state.selectedId;
    const position = selection ? captureReadingPosition() : null;
    const draft = noteIsDirty() ? {
      resourceId: selection, answer: elements["note-answer"].value,
      baseline: state.noteBaseline, sha: state.noteSHA,
      syncFailed: state.noteSyncFailed,
    } : null;

    setLoginPending(true);
    elements["login-error"].hidden = true;
    let authenticated = false;
    try {
      await api("/api/login", {
        method: "POST",
        body: { password, ...(window.HUB_REMOTE?.kind === "shared"
          ? { remember_device: true } : {}) },
        allowUnauthenticated: true,
      });
      if (token !== state.authRequestToken) return;
      setReadOnly(false);
      elements.password.value = "";
      elements.logout.hidden = false;
      showApp();
      authenticated = true;
    } catch (error) {
      if (token !== state.authRequestToken) return;
      elements["login-error"].textContent = error instanceof AuthRequiredError
        ? "用户名不正确，请再试一次。"
        : error.message || "暂时无法登录，请稍后重试。";
      elements["login-error"].hidden = false;
      elements.password.select();
    } finally {
      if (token === state.authRequestToken) setLoginPending(false);
    }
    if (authenticated) await loadWorkspace({ selection, position, draft, reconnect: true });
  }

  function captureReadingPosition() {
    const panel = document.getElementById("resource-detail");
    const target = readingTarget(elements["study-section"].value);
    return { view: state.detailView, bookPage: state.bookPage, section: readingSectionKey(elements["study-section"].value),
      offset: target ? target.getBoundingClientRect().top - panel.getBoundingClientRect().top : null,
      scroll: panel.scrollTop, detailScroll: { ...state.detailScroll } };
  }

  function restoreCurrentPosition(position) {
    if (!position) return;
    const panel = document.getElementById("resource-detail");
    state.detailScroll = { ...position.detailScroll };
    if (state.bookStudy && ['lecture', 'reflection'].includes(position.bookPage)) {
      window.HUB_BOOK_STUDY.setPage(position.bookPage, 'reconnect');
    }
    setDetailView(position.view);
    const option = [...elements["study-section"].options]
      .find(entry => readingSectionKey(entry.value) === position.section);
    if (position.view === "text" && option) {
      elements["study-section"].value = option.value;
      const target = readingTarget(option.value);
      if (target && Number.isFinite(position.offset)) {
        panel.scrollTop += target.getBoundingClientRect().top - panel.getBoundingClientRect().top - position.offset;
      }
    } else panel.scrollTop = position.scroll;
    studyNavigation.refresh();
  }

  function moduleHref(href) {
    if (!href || href.startsWith("#")) return href;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return href;
    const modulePath = /\/(reading|learning|trading|investment)\/?$/;
    if (!modulePath.test(url.pathname)) return href;
    const base = String(window.HUB_SITE_BASE || "").replace(/\/$/, "");
    if (base && /^\/(reading|learning|trading|investment)\/?$/.test(url.pathname)) url.pathname = base + url.pathname;
    if (state.readOnly) url.searchParams.set("read", "public");
    else url.searchParams.delete("read");
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function setReadOnly(enabled) {
    pauseNoteSaving();
    state.readOnly = enabled;
    if (enabled) readingNotes?.clear();
    state.modeRevision += 1;
    window.HUB_REMOTE?.setReadOnly?.(enabled);
    document.documentElement.dataset.readOnly = String(enabled);
    elements["record-status"].textContent = enabled ? "记录未连接" : "学习空间";
    elements.logout.textContent = enabled ? "连接记录" : "退出";
    elements.logout.hidden = false;
    elements["answer-tools"].hidden = enabled;
    elements["history-drawer"].hidden = enabled;
    document.querySelector(".chat-panel").hidden = enabled;
    document.querySelector('button[data-pane="chat"]').hidden = enabled;
    elements["discussion-toggle"].hidden = enabled;
    elements["notes-toggle"].hidden = enabled;
    elements["notes-panel"].hidden = enabled;
    document.querySelector('button[data-pane="notes"]').hidden = enabled;
    if (enabled) { setDiscussion(false); setNotes(false); }
    elements["model-meta"].hidden = enabled;
    document.querySelectorAll("[data-module], .site-header .brand, #text-section a[href], #detail-placement a[href]")
      .forEach(link => link.setAttribute("href", moduleHref(link.getAttribute("href"))));
    document.querySelectorAll(".section-discussion").forEach(part => {
      part.hidden = enabled;
      part.querySelector("button").disabled = enabled;
    });
    document.getElementById("book-study")?.shadowRoot?.querySelectorAll(".book-discuss").forEach(button => {
      button.disabled = enabled;
      button.hidden = enabled;
    });
    setNoteControls();
    disableComposer(true);
    if (enabled) setPane("read");
    const url = new URL(location.href);
    if (enabled) url.searchParams.set("read", "public");
    else url.searchParams.delete("read");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function enterPublicReading() {
    if (window.HUB_REMOTE?.kind !== "shared" || !mayLeaveNote()) return;
    if (state.sending) { notify("当前对话正在处理中，请稍后再阅读。"); return; }
    const selection = state.selectedId;
    const position = selection ? captureReadingPosition() : null;
    if (elements["chat-input"].value.trim()) state.publicChatDraft = {
      resourceId: selection, text: elements["chat-input"].value,
    };
    state.authRequestToken += 1;
    state.workspaceLoadToken += 1;
    state.loadingResourceToken += 1;
    state.sessionLoadToken += 1;
    state.chatRequestToken += 1;
    state.bookLoadToken += 1;
    state.noteReady = false;
    state.noteBaseline = "";
    state.noteSHA = undefined;
    state.preservedNoteDraft = false;
    elements["note-answer"].value = "";
    elements["chat-input"].value = "";
    state.sessions = [];
    state.sessionId = null;
    state.sessionResourceId = null;
    state.selectedId = null;
    elements["history-drawer"].open = false;
    setReadOnly(true);
    renderMessages([]);
    renderSessions();
    elements["note-status"].textContent = "记录未连接";
    setLoginPending(false);
    showApp();
    await loadWorkspace({ selection, position });
  }

  function setLoginPending(pending) {
    elements["login-submit"].disabled = pending;
    elements.password.disabled = pending;
    elements["login-submit"].textContent = pending ? "验证中…" : "进入";
  }

  async function logout() {
    if (!mayLeaveNote()) return;
    pauseNoteSaving();
    elements.logout.disabled = true;
    try {
      await api("/api/logout", { method: "POST" });
    } catch (error) {
      if (!(error instanceof AuthRequiredError)) {
        notify(error.message || "暂时无法退出，请稍后重试。");
        scheduleNoteSave();
        return;
      }
    } finally {
      elements.logout.disabled = false;
    }
    state.chatRequestToken += 1;
    state.sessionLoadToken += 1;
    state.loadingResourceToken += 1;
    state.bookLoadToken += 1;
    state.items = [];
    state.sessions = [];
    state.selectedId = null;
    state.sessionId = null;
    state.sessionResourceId = null;
    state.noteReady = false;
    state.noteBaseline = "";
    elements["note-answer"].value = "";
    showLogin();
  }

  function showLogin(message) {
    readingNotes?.pause();
    pauseNoteSaving();
    setNoteControls();
    elements["boot-view"].hidden = true;
    elements["app-shell"].hidden = true;
    elements["login-view"].hidden = false;
    if (message) {
      elements["login-error"].textContent = message;
      elements["login-error"].hidden = false;
    }
    window.setTimeout(() => elements.password.focus(), 0);
  }

  function showApp() {
    elements["boot-view"].hidden = true;
    elements["login-view"].hidden = true;
    elements["app-shell"].hidden = false;
  }

  async function loadWorkspace(options = {}) {
    const token = ++state.workspaceLoadToken;
    const mode = state.readOnly;
    setCatalogStatus(mode ? "正在读取…" : "正在同步…");
    try {
      const [catalog] = await Promise.all([
        api(`/api/catalog?module=${encodeURIComponent(state.module)}`),
        mode ? Promise.resolve() : refreshSessions(),
      ]);
      if (token !== state.workspaceLoadToken || mode !== state.readOnly) return;
      state.items = Array.isArray(catalog.items) ? catalog.items : [];
      if (!mode && window.HUB_REMOTE?.restoreNavigation) {
        try { await window.HUB_REMOTE.restoreNavigation(); }
        catch { setCatalogStatus("阅读位置暂未同步；可以继续阅读。"); }
      }
      if (token !== state.workspaceLoadToken || mode !== state.readOnly) return;
      elements["model-meta"].textContent = "";
      loadDiscussionModels(token, mode);
      setCatalogStatus("");
      renderResourceList();

      if (!state.items.length) {
        renderNoResources();
        return;
      }

      const requestedId = options.selection || new URLSearchParams(window.location.search).get("resource");
      const ids = state.items.map(item => item.id);
      const firstStudy = outlineOrder(state.items).find(item => window.HUB_STUDY.catalogMatches(item, state.module, "study"));
      const preferred = MODULES[state.module].initialResource || firstStudy?.id;
      const initialId = mode ? ids.includes(requestedId) ? requestedId
        : ids.includes(preferred) ? preferred : ids[0]
        : workspaceState.initial(state.module, ids, requestedId, preferred);
      await selectResource(initialId, { updateUrl: false, resumeSection: false,
        forceReload: options.reconnect, draft: options.draft, position: options.position });
      if (token !== state.workspaceLoadToken || mode !== state.readOnly) return;
      if (options.reconnect && state.publicChatDraft?.resourceId === state.selectedId) {
        elements["chat-input"].value = state.publicChatDraft.text;
        state.publicChatDraft = null;
      }
      if (options.reconnect && state.sessionId) {
        const session = state.sessions.find(entry => entry.id === state.sessionId && entry.resource_id === initialId);
        if (session) await loadSession(session.id);
        else clearCurrentConversation();
      }
      if (window.location.hash === "#links-section") {
        if (state.bookStudy) window.HUB_BOOK_STUDY.jump("sources");
        else jumpTo("links-title");
      }
    } catch (error) {
      if (token !== state.workspaceLoadToken || mode !== state.readOnly) return;
      if (error instanceof AuthRequiredError) return;
      setCatalogStatus("同步失败");
      renderWorkspaceError(error.message || "资料加载失败，请刷新后重试。");
    }
  }

  async function refreshSharedState() {
    if (state.readOnly || window.HUB_REMOTE?.kind !== "shared" || elements["app-shell"].hidden
        || state.refreshingShared || state.sending || state.savingNote) return;
    state.refreshingShared = true;
    const resourceId = state.selectedId;
    const sessionId = state.sessionId;
    const resourceToken = state.loadingResourceToken;
    const sessionToken = state.sessionLoadToken;
    const requestToken = state.chatRequestToken;
    const noteRevision = state.noteEditRevision;
    const modeRevision = state.modeRevision;
    const authToken = state.authRequestToken;
    const current = () => !state.readOnly && !elements["app-shell"].hidden
      && modeRevision === state.modeRevision && authToken === state.authRequestToken;
    const canRefreshNote = state.noteReady && !state.noteComposing && !noteIsDirty();
    try {
      await refreshSessions();
      if (!current()) return;
      await readingNotes?.refresh();
      if (!current()) return;
      if (canRefreshNote && resourceId && noteRevision === state.noteEditRevision && !noteIsDirty()) {
        const record = await api(`/api/notes?module=${encodeURIComponent(state.module)}&resource_id=${encodeURIComponent(resourceId)}`,
          { preserveVersion: true });
        // Editing or navigating while the network request runs preserves both
        // the draft and its original SHA, so an unseen update cannot be erased.
        if (current() && noteRevision === state.noteEditRevision
            && resourceToken === state.loadingResourceToken && resourceId === state.selectedId
            && state.noteReady && !state.noteComposing && !noteIsDirty() && !state.savingNote) {
          const answer = typeof record?.answer === "string" ? record.answer : "";
          window.HUB_REMOTE.acceptNoteSnapshot(state.module, resourceId, record);
          if (answer !== state.noteBaseline) elements["note-status"].textContent = "已同步最新回答。";
          elements["note-answer"].value = answer;
          state.noteBaseline = answer;
          state.noteSHA = record.sha;
        }
      }
      if (!current()) return;
      if (sessionId && sessionId === state.sessionId && !state.sending) {
        const record = await api(`/api/sessions/${encodeURIComponent(sessionId)}?module=${encodeURIComponent(state.module)}`);
        if (current() && sessionToken === state.sessionLoadToken && requestToken === state.chatRequestToken
            && sessionId === state.sessionId && resourceId === state.selectedId && !state.sending
            && record.resource_id === state.sessionResourceId) {
          renderMessages(Array.isArray(record.messages) ? record.messages : []);
        }
      }
      if (!current()) return;
      await window.HUB_REMOTE.flushNavigation().catch(() => {});
      if (!current()) return;
      await window.HUB_REMOTE.restoreNavigation().catch(() => {});
    } catch (error) {
      if (current() && !(error instanceof AuthRequiredError)) setCatalogStatus("同步暂未完成");
    } finally {
      state.refreshingShared = false;
    }
  }

  function positionCatalogPicker() {
    const menu = elements["catalog-topics"];
    const trigger = elements["catalog-location"].getBoundingClientRect();
    const panel = document.querySelector(".library-panel").getBoundingClientRect();
    const top = Math.max(8, panel.top + 8);
    const bottom = Math.min(window.innerHeight - 8, panel.bottom - 8);
    const below = Math.max(0, bottom - trigger.bottom - 4);
    const above = Math.max(0, trigger.top - top - 4);
    const opensAbove = below < Math.min(menu.scrollHeight, 180) && above > below;
    menu.dataset.placement = opensAbove ? "above" : "below";
    menu.style.maxHeight = `${Math.floor(Math.min(420, opensAbove ? above : below))}px`;
  }

  function focusCatalogTopic(button) {
    if (!button) return;
    const menu = elements["catalog-topics"];
    button.focus({ preventScroll: true });
    if (button.offsetTop < menu.scrollTop) menu.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = button.offsetTop + button.offsetHeight - menu.clientHeight;
    }
  }

  function setCatalogPicker(open, focus = false) {
    state.catalogBrowsing = open && !elements["catalog-location"].hidden;
    elements["catalog-location"].setAttribute("aria-expanded", String(state.catalogBrowsing));
    elements["catalog-topics"].hidden = !state.catalogBrowsing;
    if (state.catalogBrowsing) {
      positionCatalogPicker();
      if (focus) focusCatalogTopic(elements["catalog-topics"].querySelector('[aria-current="true"]'));
    }
  }

  function renderResourceList() {
    const query = elements["resource-search"].value.trim();
    const filter = elements["resource-content"].value;
    const candidates = state.items.filter(item => window.HUB_STUDY.catalogMatches(item, state.module, filter));
    const groups = new Map();
    outlineOrder(candidates).forEach(item => {
      const outline = catalogOutline(item);
      if (!groups.has(outline.groupKey)) groups.set(outline.groupKey, { title: outline.groupTitle, count: 0 });
      groups.get(outline.groupKey).count++;
    });
    if (groups.size < 2) state.catalogBrowsing = false;
    elements["catalog-location"].hidden = groups.size < 2;
    elements["catalog-picker"].hidden = groups.size < 2;
    elements["catalog-scope"].textContent = query ? "搜索全部" : groups.get(state.catalogScope)?.title || "全部";
    setCatalogPicker(state.catalogBrowsing, false);
    elements["catalog-topics"].replaceChildren();
    if (groups.size > 1) {
      [["", { title: "全部", count: candidates.length }], ...groups].forEach(([key, group]) => {
        const button = make("button", "catalog-topic");
        button.type = "button";
        button.dataset.catalogScope = key;
        button.setAttribute("aria-current", String(key === (state.catalogScope || "")));
        button.append(make("span", "", group.title), make("span", "catalog-topic-count", String(group.count)));
        button.addEventListener("click", () => {
          state.catalogScope = key;
          state.catalogBrowsing = false;
          elements["resource-search"].value = "";
          renderResourceList();
          elements["catalog-location"].focus({ preventScroll: true });
        });
        elements["catalog-topics"].append(button);
      });
    }
    const matches = query ? window.HUB_STUDY.searchCatalog(state.items, query)
      : outlineOrder(candidates.filter(item => !state.catalogScope || catalogOutline(item).groupKey === state.catalogScope));
    const visible = matches;
    const list = elements["resource-list"];
    list.replaceChildren();
    list.dataset.content = query ? "all" : filter;
    elements["resource-count"].textContent = `${visible.length} 项${query ? "匹配" : "材料"}`;
    if (!visible.length) {
      list.append(make("p", "empty-list", query ? "没有匹配的资料，试试书名、作者或关键词。" : "此范围暂无材料，可切换主题或内容类型。"));
      return;
    }
    const fragment = document.createDocumentFragment();
    visible.forEach((item) => {
      const outline = catalogOutline(item);
      const button = make("button", "resource-item");
      button.type = "button";
      button.dataset.resourceId = item.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(item.id === state.selectedId));
      button.tabIndex = item.id === state.selectedId || (!visible.some(row => row.id === state.selectedId) && item === visible[0]) ? 0 : -1;
      button.classList.toggle("active", item.id === state.selectedId);
      const title = make("strong", "", item.title || "未命名资料");
      if (state.module === "trading") title.append(make("span", "resource-kind", materialKindLabel(item.kind)));
      if (item.sequence) {
        const number = make("span", "sequence-number", String(item.sequence.position).padStart(2, "0"));
        number.setAttribute("aria-label", `第 ${item.sequence.position} 项`);
        title.prepend(number);
      }
      button.append(title);
      if (query || !state.catalogScope) button.append(make("span", "resource-location", outline.groupTitle));
      const rawSubtitle = item.subtitle || preview(item.body) || "打开查看详情";
      const subtitle = rawSubtitle.replace(`${item.group} · `, "").replace(/ · 研究状态：[^·]+$/, "");
      button.append(make("span", "resource-subtitle", subtitle));
      if (item.placement && (state.module === "learning" || ["METADATA", "RESOURCE_ROUTE"].includes(item.placement.depth))) {
        const label = state.module === "learning" ? item.evidence?.lesson ? "教学课" : "资源路线" : item.placement.depth_label;
        button.append(make("span", "resource-placement", label));
      }
      fragment.append(button);
    });
    list.append(fragment);
    if (!query) {
      const active = list.querySelector('[aria-selected="true"]');
      if (active) list.scrollTop = Math.max(0, active.offsetTop - list.offsetTop - 36);
      else list.scrollTop = 0;
    }
  }

  function catalogOutline(item) {
    const placement = item.placement || {};
    if (state.module === "learning") {
      return {
        groupKey: placement.spine_id || item.group,
        groupTitle: placement.spine_title || item.group,
        groupOrder: ({
          "reasoning-from-evidence": 1,
          "computing-systems": 2,
          "models-intelligent-systems": 3,
          "financial-decisions": 4,
          "learning-domain-map": 5,
        })[placement.spine_id] || 99,
        stageKey: placement.stage_id || item.group,
        stageTitle: placement.scope === "INITIAL_SPINE"
          ? `阶段 ${placement.position} · ${placement.stage_title}`
          : placement.stage_title,
        stageOrder: placement.position || 99,
      };
    }
    if (state.module === "trading") {
      return {
        groupKey: placement.stage_id || item.group,
        groupTitle: placement.stage_title
          ? `阶段 ${placement.position} · ${placement.stage_title}`
          : item.group,
        groupOrder: placement.position || 99,
        stageKey: "",
        stageTitle: "",
        stageOrder: 0,
      };
    }
    return {
      groupKey: item.group,
      groupTitle: item.group,
      groupOrder: state.items.findIndex(row => row.group === item.group),
      stageKey: "",
      stageTitle: "",
      stageOrder: 0,
    };
  }

  function outlineOrder(items) {
    const indexes = new Map(state.items.map((item, index) => [item.id, index]));
    return [...items].sort((left, right) => {
      const a = catalogOutline(left);
      const b = catalogOutline(right);
      return a.groupOrder - b.groupOrder
        || a.stageOrder - b.stageOrder
        || a.stageKey.localeCompare(b.stageKey)
        || indexes.get(left.id) - indexes.get(right.id);
    });
  }

  function materialKindLabel(kind) {
    return ({
      methodology: "方法",
      case: "假设案例",
      walkthrough: "历史研读",
      snapshot: "研究快照",
    })[kind] || "材料";
  }

  function navigateResourceList(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = Array.from(elements["resource-list"].querySelectorAll("[data-resource-id]"));
    if (!options.length) return;
    event.preventDefault();
    const currentIndex = options.indexOf(document.activeElement);
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    else if (event.key === "ArrowDown") nextIndex = Math.min(options.length - 1, currentIndex + 1);
    else nextIndex = Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1);
    const id = options[nextIndex].dataset.resourceId;
    options[nextIndex].focus();
    selectResource(id, { updateUrl: true }).then(accepted => {
      if (accepted && state.selectedId === id) {
        elements["resource-list"].querySelector('[aria-selected="true"]')?.focus();
      }
    });
  }

  async function selectResource(resourceId, options) {
    const item = findItem(resourceId);
    if (!item) return false;
    if (state.selectedId === item.id && !options?.forceReload) {
      if (options?.updateUrl) {
        if (state.bookStudy) setBookPage('lecture');
        resetReadingTop();
      }
      return true;
    }
    const draft = options?.draft?.resourceId === item.id ? options.draft : null;
    if (!draft && !mayLeaveNote({ retainReadingNotes: state.selectedId === item.id && options?.forceReload })) return false;
    const operation = ++state.selectionRequestToken;
    const mode = state.modeRevision;

    const changed = state.selectedId !== item.id;
    readingNotes?.pause();
    state.positionReady = false;
    elements["resume-status"].hidden = true;
    if (!(options && options.fromSession)) state.sessionLoadToken += 1;
    state.selectedId = item.id;
    state.catalogBrowsing = false;
    if (!window.HUB_STUDY.catalogMatches(item, state.module, elements["resource-content"].value)) {
      elements["resource-content"].value = "all";
    }
    renderResourceList();
    const active = elements["resource-list"].querySelector('[aria-selected="true"]');
    if (active) elements["resource-list"].scrollTop = Math.max(0,
      active.offsetTop - elements["resource-list"].offsetTop - 36);
    renderResource(item);
    elements["chat-context"].textContent = item.title || "未命名资料";
    disableComposer(state.readOnly);

    if (changed) {
      clearCurrentConversation();
      if (options && options.updateUrl) updateResourceUrl(item.id);
    }
    await Promise.all([loadNote(item.id, { draft }), state.module === "reading" && item.kind === "book" ? loadBookStudy(item) : Promise.resolve()]);
    if (state.selectedId !== item.id || operation !== state.selectionRequestToken || mode !== state.modeRevision) return false;
    if (readingNotes) {
      let digest = state.bookStudy?.input_hash || '';
      if (!digest && crypto.subtle) {
        digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.body || '')))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
      }
      if (state.selectedId !== item.id || operation !== state.selectionRequestToken || mode !== state.modeRevision) return false;
      const book = document.getElementById('book-study')?.shadowRoot;
      readingNotes.setMaterial({ module: state.module, id: item.id },
        [elements['detail-body'], book], digest).catch(() => {});
    }
    if (!state.readOnly) workspaceState.remember(state.module, item.id);
    restoreReadingPosition(item, options?.resumeSection === true && !options?.position);
    restoreCurrentPosition(options?.position);
    disableComposer(state.readOnly);
    return true;
  }

  async function loadBookStudy(item) {
    const token = ++state.bookLoadToken;
    const mode = state.modeRevision;
    const host = document.getElementById("book-study");
    host.hidden = false;
    host.replaceChildren(make("p", "", "正在载入完整研究…"));
    try {
      const study = await api(`/api/reading/${encodeURIComponent(item.id)}/study`);
      if (token !== state.bookLoadToken || mode !== state.modeRevision || state.selectedId !== item.id) return;
      state.bookStudy = study;
      const mounted = window.HUB_BOOK_STUDY.mount(host, study, section => {
        if (state.readOnly || state.sending) return;
        if (elements["chat-input"].value.trim() && !window.confirm("替换输入框里尚未发送的问题吗？")) return;
        const position = study.sections.findIndex(entry => entry.id === section.id) + 1;
        elements["chat-input"].value = window.HUB_STUDY.question(item, { ...section, position }, "explain");
        setPane("chat");
        elements["chat-input"].focus();
      });
      host.shadowRoot.querySelectorAll(".book-discuss").forEach(button => {
        button.disabled = state.readOnly;
        button.hidden = state.readOnly;
      });
      host.shadowRoot.querySelectorAll("a[href]").forEach(link => {
        link.setAttribute("href", moduleHref(link.getAttribute("href")));
      });
      await mounted;
      if (token !== state.bookLoadToken || mode !== state.modeRevision || state.selectedId !== item.id) return;
      const quote = host.shadowRoot.querySelector("#takeaway blockquote");
      const takeaway = quote ? [...quote.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent).join("").replace(/\s+/g, " ").trim() : "";
      const summaries = (item.evidence?.claims || []).filter(claim => claim.statement.replace(/\s+/g, " ").trim() === takeaway);
      if (takeaway && summaries.length === 1) renderPlacement(item, summaries[0]);
      configureBookSections();
      resetReadingTop();
    } catch (error) {
      if (token !== state.bookLoadToken || mode !== state.modeRevision || state.selectedId !== item.id) return;
      host.replaceChildren(make("p", "", error.message || "完整研究加载失败。"));
      const retry = make("button", "secondary-button", "重新加载");
      retry.type = "button";
      retry.addEventListener("click", async () => {
        await loadBookStudy(item);
        if (state.selectedId === item.id) restoreReadingPosition(item, false);
      });
      host.append(retry);
    }
  }

  function renderResource(item) {
    studyNavigation.setTargets([]);
    state.bookLoadToken += 1;
    state.bookStudy = null;
    state.bookPage = 'lecture';
    // Replacing the host drops old shadow contents and prevents stale book flashes.
    const previousHost = document.getElementById("book-study");
    const newHost = make("div", "");
    newHost.id = "book-study";
    newHost.hidden = state.module !== "reading" || item.kind !== "book";
    elements['book-reading-modes'].hidden = newHost.hidden;
    if (!newHost.hidden) {
      newHost.setAttribute('role', 'tabpanel');
      newHost.setAttribute('aria-labelledby', 'book-page-lecture');
    }
    elements['book-reading-modes'].querySelectorAll('[data-book-page]').forEach(button => {
      const active = button.dataset.bookPage === 'lecture';
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      button.disabled = true;
    });
    previousHost.replaceWith(newHost);
    elements["detail-empty"].hidden = true;
    elements["detail-content"].hidden = false;
    elements["detail-title"].textContent = item.title || "未命名资料";
    renderPlacement(item);
    const subtitle = state.module === "learning"
      ? (item.subtitle || "").replace(`${item.group} · `, "").replace(/ · (含入门试讲|资源路线)$/, "")
      : item.subtitle || "";
    elements["detail-subtitle"].textContent = subtitle.replace(/ · 研究状态：[^·]+$/, "");
    elements["detail-subtitle"].hidden = !item.subtitle;

    const inlineBook = state.module === "reading" && item.kind === "book";
    state.studySections = inlineBook ? [] : window.HUB_STUDY.sections(item.body);
    elements["study-section"].replaceChildren();
    state.studySections.forEach((section, index) => elements["study-section"].append(new Option(`${index + 1}. ${section.title}`, String(index))));
    renderStudy();

    const sources = item.evidence?.sources || [];
    const sourceUrls = new Set(sources.map(source => source.url));
    renderLinks((item.links || []).filter(link => !sourceUrls.has(link.url)));
    window.HUB_EVIDENCE.render(document.getElementById("evidence-ledger"),
      inlineBook ? { publication: item.evidence?.publication } : item.evidence || {});
    if (typeof item.evidence?.methodology === "string") {
      const details = make("section", "methodology-source");
      details.append(make("h4", "", "完整方法约定 · 内部工作流程"));
      const body = make("div", "detail-body");
      renderStructuredText(body, item.evidence.methodology);
      details.append(body);
      elements["resource-links"].append(details);
    }
    const hasExtensions = Boolean(elements["resource-links"].childElementCount
      || document.getElementById("evidence-ledger").childElementCount);
    elements["links-section"].hidden = !hasExtensions;
    if (hasExtensions) elements["study-section"].append(new Option("延伸与证据", "extensions"));
    document.getElementById("study-controls").hidden = state.studySections.length < 2 && !hasExtensions;
    const hasExercise = Boolean(String(item.exercise || "").trim());
    elements["exercise-panel"].hidden = !hasExercise;
    elements["exercise-prompt"].textContent = hasExercise ? item.exercise : "";
    elements["note-answer"].disabled = state.readOnly || !hasExercise;
    elements["save-note"].disabled = state.readOnly || !hasExercise;
    renderPractice(item);
    renderMaterialSequence(item);
    state.detailView = "text";
    state.detailScroll = {};
    document.getElementById("resource-detail").scrollTop = 0;
    setDetailView("text");
    elements["detail-body"].hidden = inlineBook;
    if (inlineBook) {
      elements["detail-body"].replaceChildren();
      document.getElementById("evidence-ledger").replaceChildren();
      document.getElementById("study-controls").hidden = true;
    } else {
      studyNavigation.setTargets([
        ...state.studySections.map((section, index) => ({
          element: document.getElementById(`study-heading-${index}`), value: String(index),
        })),
        ...(hasExtensions ? [{ element: document.getElementById("links-title"), value: "extensions" }] : []),
      ]);
    }
  }

  function resetReadingTop() {
    document.getElementById('resource-detail').scrollTo({ top: 0, behavior: 'instant' });
  }

  function setBookPage(page) {
    if (!state.bookStudy) return;
    window.HUB_BOOK_STUDY.setPage(page);
    state.detailView = 'text';
    resetReadingTop();
  }

  function configureBookSections() {
    if (!state.bookStudy) return;
    const host = document.getElementById('book-study');
    const pages = window.HUB_BOOK_STUDY.pageSections(state.bookStudy);
    const sections = state.bookStudy.sections.map((section, index) => ({ section, index }))
      .filter(({ section }) => pages[section.id] === 'shared' || pages[section.id] === state.bookPage);
    elements['study-section'].replaceChildren(...sections.map(({ section, index }) => new Option(section.title, String(index))));
    const hasExtensions = !elements['links-section'].hidden;
    if (hasExtensions) elements['study-section'].append(new Option('延伸与证据', 'extensions'));
    document.getElementById('study-controls').hidden = false;
    studyNavigation.setTargets([
      ...sections.map(({ section, index }) => ({ element: host.shadowRoot.getElementById(section.id), value: String(index) })),
      ...(hasExtensions ? [{ element: document.getElementById('links-title'), value: 'extensions' }] : []),
    ]);
  }

  function renderPlacement(item, summary = null) {
    const host = elements["detail-placement"];
    host.replaceChildren();
    if (state.module === "reading" && item.kind === "book") {
      const description = summary?.statement || item.evidence?.entry_question;
      host.hidden = !description;
      if (description) {
        const paragraph = make("p", "book-entry-question");
        if (summary) {
          paragraph.dataset.source = "study-takeaway";
          paragraph.dataset.claimId = summary.claim_id;
          paragraph.dataset.claimKind = summary.kind;
          const label = ({ AUTHOR_CLAIM: "书中论述", MODEL_INFERENCE: "导读归纳",
            EXTERNAL_ASSESSMENT: "研究评述", CONTEXT: "背景信息" })[summary.kind];
          if (label) paragraph.append(make("span", "book-summary-kind", label + "："));
          paragraph.append(make("span", "book-summary-text", description));
        } else {
          paragraph.textContent = description;
        }
        host.append(paragraph);
      }
      return;
    }
    const placement = item.placement;
    if (!placement) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.append(make("span", "placement-spine", placement.spine_title));
    if (placement.stage_title !== item.title) host.append(make("span", "placement-stage", placement.stage_title));
    if (["METADATA", "RESOURCE_ROUTE"].includes(placement.depth)) {
      host.append(make("span", "placement-depth", placement.depth_label));
    }
    const researchStatus = (item.subtitle || "").match(/研究状态：(.+)$/)?.[1];
    if (researchStatus) host.append(make("span", "placement-research-status", `研究状态：${researchStatus}`));
    const prerequisites = (placement.prerequisite_ids || []).map(findItem).filter(Boolean);
    if (prerequisites.length) {
      const prerequisiteList = make("span", "placement-prerequisites", "先修：");
      prerequisites.forEach((target, index) => {
        if (index) prerequisiteList.append(document.createTextNode("、"));
        const link = make("a", "", target.title);
        link.href = moduleHref(`/${state.module}?resource=${encodeURIComponent(target.id)}`);
        link.addEventListener("click", event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
          event.preventDefault();
          selectResource(target.id, { updateUrl: true });
        });
        prerequisiteList.append(link);
      });
      host.append(prerequisiteList);
    }
  }

  function renderMaterialSequence(item) {
    const nav = document.getElementById("material-sequence");
    nav.replaceChildren();
    nav.hidden = !item.sequence;
    if (!item.sequence) return;
    const heading = make("p", "sequence-caption", state.module === "learning"
      ? "继续学习" : "继续阅读");
    const links = make("div", "sequence-links");
    for (const [key, label] of [["previous_id", "← 前一项"], ["next_id", "后一项 →"]]) {
      const target = findItem(item.sequence[key]);
      if (!target) continue;
      const link = make("a", "");
      link.href = moduleHref(`/${state.module}?resource=${encodeURIComponent(target.id)}`);
      link.append(make("span", "", label), make("strong", "", target.title));
      link.addEventListener("click", event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
        event.preventDefault();
        selectResource(target.id, { updateUrl: true });
      });
      links.append(link);
    }
    nav.append(heading, links);
  }

  function readingSectionKey(value) {
    if (value === "extensions") return "extensions";
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0) return null;
    if (state.bookStudy) {
      const section = state.bookStudy.sections[index];
      return section ? `book:${section.id}` : null;
    }
    const section = state.studySections[index];
    if (!section) return null;
    const occurrence = state.studySections.slice(0, index).filter(row => row.title === section.title).length;
    return `heading:${JSON.stringify([section.title, occurrence])}`;
  }

  function readingTarget(value) {
    if (value === "extensions") return document.getElementById("links-title");
    const index = Number(value);
    if (state.bookStudy) {
      const section = state.bookStudy.sections[index];
      return section ? document.getElementById("book-study")?.shadowRoot?.getElementById(section.id) : null;
    }
    return document.getElementById(`study-heading-${index}`);
  }

  function restoreReadingPosition(item, resume = true) {
    const operation = state.selectionRequestToken;
    const mode = state.modeRevision;
    if (state.module === "reading" && item.kind === "book" && !state.bookStudy) return;
    const saved = !state.readOnly && resume && !elements["resource-search"].value
      ? workspaceState.section(state.module, item.id) : null;
    const option = saved && Array.from(elements["study-section"].options)
      .find(entry => readingSectionKey(entry.value) === saved);
    if (option) {
      if (option.value === "extensions") jumpTo("links-title");
      else selectStudy(Number(option.value));
      if (option.value !== "0") {
        elements["resume-status"].textContent = "已恢复上次正文位置";
        elements["resume-status"].hidden = false;
      }
    }
    requestAnimationFrame(() => {
      if (state.selectedId !== item.id || operation !== state.selectionRequestToken || mode !== state.modeRevision) return;
      state.positionReady = true;
      studyNavigation.refresh();
    });
  }

  function setFocus(enabled, persist = true) {
    if (enabled) { setDiscussion(false); setNotes(false); }
    const target = state.detailView === "text" ? readingTarget(elements["study-section"].value) : null;
    const before = target?.getBoundingClientRect().top;
    document.documentElement.dataset.focus = String(Boolean(enabled));
    elements["focus-toggle"].textContent = enabled ? "退出专注" : "专注阅读";
    elements["focus-toggle"].setAttribute("aria-pressed", String(Boolean(enabled)));
    elements["focus-toggle"].setAttribute("aria-label", enabled
      ? "退出专注阅读，显示目录和讨论" : "进入专注阅读，收起目录和讨论");
    if (target && Number.isFinite(before)) {
      document.getElementById("resource-detail").scrollTop += target.getBoundingClientRect().top - before;
    }
    if (persist && !state.readOnly) workspaceState.setFocus(enabled);
    studyNavigation?.refresh();
  }

  function selectStudy(index) {
    if (state.bookStudy) {
      const section = state.bookStudy.sections[index];
      if (section) {
        elements["study-section"].value = String(index);
        window.HUB_BOOK_STUDY.jump(section.id);
        if (!state.readOnly && state.positionReady) workspaceState.rememberSection(state.module, state.selectedId, readingSectionKey(String(index)));
      }
      return;
    }
    if (index < 0 || index >= state.studySections.length) return;
    elements["study-section"].value = String(index);
    jumpTo(`study-heading-${index}`);
    if (!state.readOnly && state.positionReady) workspaceState.rememberSection(state.module, state.selectedId, readingSectionKey(String(index)));
  }

  function jumpTo(id) {
    const target = document.getElementById(id);
    if (!target) return;
    target.tabIndex = -1;
    if (document.documentElement.dataset.input === 'keyboard') target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  }

  function renderStudy() {
    const count = state.studySections.length;
    const body = elements["detail-body"];
    body.replaceChildren();
    document.getElementById("study-controls").hidden = !count;
    elements["study-section"].value = "0";
    if (!count) body.append(make("p", "", "这项资料暂时没有正文说明。"));
    const item = findItem(state.selectedId);
    body.dataset.kind = item?.kind || "";
    state.studySections.forEach((section, index) => {
      const part = make("section", "study-part");
      part.id = `study-part-${index}`;
      const heading = make("h3", "study-heading", section.title);
      if (index === 0 && section.title === item?.title) heading.classList.add("sr-only");
      heading.id = `study-heading-${index}`;
      heading.tabIndex = -1;
      part.append(heading);
      renderStructuredText(part, section.body);
      if (index === 0 && item?.kind === "reading_program") window.HUB_PROGRAM?.render(part, item.evidence);
      if (state.module === "learning") {
        const resourceLinks = make("div", "section-resources");
        (item.links || []).filter(link => section.body.includes(link.label)).forEach(link => {
          const href = safeHref(link.url);
          if (!href) return;
          const anchor = make("a", "resource-link", link.label);
          anchor.href = href;
          if (isExternalHref(href)) {
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
          }
          resourceLinks.append(anchor);
        });
        if (resourceLinks.childElementCount) part.append(resourceLinks);
      }
      const discussion = make("div", "section-discussion");
      discussion.setAttribute("aria-label", `讨论：${section.title}`);
      const button = make("button", "", "讨论本节");
      button.type = "button";
      button.disabled = state.readOnly;
      button.setAttribute("aria-label", `讨论：${section.title}`);
      button.addEventListener("click", () => {
        if (state.readOnly || state.sending) return;
        if (elements["chat-input"].value.trim() && !window.confirm("替换输入框里尚未发送的问题吗？")) return;
        elements["chat-input"].value = window.HUB_STUDY.question(item, section, "explain");
        setPane("chat");
        elements["chat-input"].focus();
      });
      discussion.append(button);
      discussion.hidden = state.readOnly;
      part.append(discussion);
      body.append(part);
    });
  }

  function setDetailView(view) {
    const panel = document.getElementById("resource-detail");
    if (view === "practice") {
      if (state.detailView !== "practice") state.detailScroll.text = panel.scrollTop;
      state.detailView = "practice";
      document.getElementById("answer-tools").open = true;
      jumpTo("exercise-panel");
    } else {
      if (state.detailView === "practice") panel.scrollTop = state.detailScroll.text || 0;
      state.detailView = "text";
    }
    studyNavigation.refresh();
  }

  function renderPractice(item) {
    const guide = item.practice;
    const panel = elements["practice-guide"];
    panel.replaceChildren();
    elements["insert-worksheet"].hidden = !guide;
    elements["discuss-note"].hidden = !guide;
    document.getElementById("exercise-title").textContent = guide?.title || "练习回答";
    if (!guide) return;
    panel.append(make("h4", "", "作答提示与自检"));
    const steps = make("ol", "practice-steps");
    guide.steps.forEach(step => {
      const row = make("li", "");
      row.append(make("h4", "", step.title), make("p", "", step.prompt));
      steps.append(row);
    });
    const walkthrough = make("div", "practice-walkthrough");
    walkthrough.append(steps);
    const review = make("div", "practice-checks");
    review.append(make("p", "", "写完后检查："));
    const checks = make("ul", "");
    guide.checks.forEach(check => checks.append(make("li", "", check)));
    review.append(checks);
    panel.append(walkthrough, review, make("p", "practice-disclaimer", guide.boundary));
  }

  function noteIsDirty() {
    return state.preservedNoteDraft || state.noteReady
      && (state.noteSyncFailed || elements["note-answer"].value !== state.noteBaseline);
  }

  function clearNoteSaveTimer() {
    window.clearTimeout(noteSaveTimer);
    noteSaveTimer = undefined;
  }

  function pauseNoteSaving() {
    clearNoteSaveTimer();
    // A timed-out or superseded write may have reached the server. Keep the
    // draft guarded until a version-checked retry or a deliberate discard.
    if (state.savingNote) state.noteSyncFailed = true;
    state.noteSaveToken += 1;
    state.savingNote = false;
    state.noteComposing = false;
  }

  function noteScope() {
    return { module: state.module, resourceId: state.selectedId,
      resourceToken: state.loadingResourceToken, modeRevision: state.modeRevision,
      authToken: state.authRequestToken, saveToken: state.noteSaveToken };
  }

  function currentNoteScope(scope) {
    return !state.readOnly && !elements["app-shell"].hidden
      && scope.module === state.module && scope.resourceId === state.selectedId
      && scope.resourceToken === state.loadingResourceToken && scope.modeRevision === state.modeRevision
      && scope.authToken === state.authRequestToken && scope.saveToken === state.noteSaveToken;
  }

  function canAutoSaveNote() {
    return window.HUB_REMOTE?.kind === "shared" && !state.readOnly && !elements["app-shell"].hidden
      && state.noteReady && !state.savingNote && !state.noteSyncFailed && !state.noteComposing
      && Boolean(state.selectedId) && noteIsDirty();
  }

  function scheduleNoteSave() {
    clearNoteSaveTimer();
    if (!canAutoSaveNote()) return;
    const scope = noteScope();
    noteSaveTimer = window.setTimeout(() => {
      noteSaveTimer = undefined;
      if (currentNoteScope(scope) && canAutoSaveNote()) saveNote({ automatic: true });
    }, NOTE_SAVE_DELAY);
  }

  function noteChanged() {
    state.noteEditRevision += 1;
    elements['note-organization'].hidden = true;
    elements['note-organization-retry'].hidden = true;
    if (state.readOnly || !state.noteReady) return;
    elements["note-status"].textContent = state.noteSyncFailed
      ? "草稿已保留，请重试保存。"
      : state.savingNote ? "正在保存；新修改会接着保存。"
      : noteIsDirty() ? window.HUB_REMOTE?.kind === "shared" ? "修改待同步…" : "有尚未保存的修改。"
      : "回答与已保存版本一致。";
    scheduleNoteSave();
  }

  function mayLeaveNote(options = {}) {
    if (readingNotes && !options.retainReadingNotes && !readingNotes.mayLeave()) return false;
    if (state.savingNote) {
      notify("回答正在保存，请稍等再切换资料。");
      return false;
    }
    return !noteIsDirty() || window.confirm("这份回答还没有保存。离开会丢弃修改，仍然继续吗？");
  }

  function setNoteControls() {
    elements["note-answer"].disabled = state.readOnly || !state.noteReady;
    ["save-note", "insert-worksheet", "discuss-note"].forEach(id => {
      elements[id].disabled = state.readOnly || !state.noteReady || state.savingNote;
    });
    elements["save-note"].textContent = state.savingNote ? "保存中…"
      : state.noteSyncFailed ? "重试保存" : window.HUB_REMOTE?.kind === "shared" ? "立即保存" : "保存回答";
  }

  function insertWorksheet() {
    const guide = findItem(state.selectedId)?.practice;
    if (state.readOnly || !guide || !state.noteReady || state.savingNote) return;
    const answer = elements["note-answer"];
    const template = guide.worksheet.map(label => `${label}：\n`).join("\n");
    answer.value += (answer.value ? "\n\n" : "") + template;
    answer.dispatchEvent(new Event("input"));
    answer.focus();
  }

  async function prepareNoteDiscussion() {
    const item = findItem(state.selectedId);
    if (state.readOnly || !item?.practice || !state.noteReady || state.savingNote || state.sending) return;
    if (!elements["note-answer"].value.trim()) {
      notify("先写下一个想法或疑问，再开始讨论。");
      elements["note-answer"].focus();
      return;
    }
    if (elements["chat-input"].value.trim() && !window.confirm("输入框里已有问题，要替换成这次练习的讨论问题吗？")) return;
    if (!await saveNote() || state.selectedId !== item.id) return;
    elements["chat-input"].value = item.practice.discussion;
    setPane("chat");
    elements["chat-input"].focus();
    notify("回答已保存，问题已准备好；确认后再发送。");
  }

  function setDiscussion(enabled) {
    enabled = Boolean(enabled) && !state.readOnly;
    const target = state.detailView === "text" ? readingTarget(elements["study-section"].value) : null;
    const before = target?.getBoundingClientRect().top;
    if (enabled && document.documentElement.dataset.focus === "true") setFocus(false);
    if (enabled) setNotes(false);
    document.documentElement.dataset.discussion = String(enabled);
    elements["discussion-toggle"].setAttribute("aria-expanded", String(enabled));
    if (!enabled && document.documentElement.dataset.pane === "chat") setPane("read");
    if (target && Number.isFinite(before)) {
      document.getElementById("resource-detail").scrollTop += target.getBoundingClientRect().top - before;
    }
    studyNavigation?.refresh();
  }

  function setPane(pane) {
    if (state.readOnly && ['chat', 'notes'].includes(pane)) return;
    if (pane === "chat") setDiscussion(true);
    if (pane === "notes") setNotes(true);
    if (pane !== "read" && window.matchMedia("(min-width: 1181px)").matches
        && document.documentElement.dataset.focus === "true") setFocus(false);
    document.documentElement.dataset.pane = pane;
    document.querySelectorAll("button[data-pane]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.pane === pane));
    });
  }

  function setNotes(enabled) {
    enabled = Boolean(enabled) && !state.readOnly;
    const target = state.detailView === "text" ? readingTarget(elements["study-section"].value) : null;
    const before = target?.getBoundingClientRect().top;
    if (enabled) {
      if (document.documentElement.dataset.focus === "true") setFocus(false);
      setDiscussion(false);
    }
    document.documentElement.dataset.notes = String(enabled);
    elements["notes-toggle"].setAttribute("aria-expanded", String(enabled));
    if (!enabled && document.documentElement.dataset.pane === "notes") setPane("read");
    if (enabled) readingNotes?.refresh();
    if (target && Number.isFinite(before)) {
      document.getElementById("resource-detail").scrollTop += target.getBoundingClientRect().top - before;
    }
    studyNavigation?.refresh();
  }

  function renderLinks(links) {
    elements["resource-links"].replaceChildren();
    const safeLinks = (Array.isArray(links) ? links : [])
      .map((link) => ({ link, href: safeHref(link && link.url) }))
      .filter((entry) => entry.href);
    safeLinks.forEach(({ link, href }) => {
      const anchor = make("a", "resource-link", link.label || "打开资料");
      anchor.href = moduleHref(href);
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.setAttribute("aria-label", `${link.label || "打开资料"}（新标签页）`);
      const entry = make("div", "source-entry");
      entry.append(anchor);
      if (link.description) entry.append(make("p", "source-description", link.description));
      elements["resource-links"].append(entry);
    });
  }

  async function loadNote(resourceId, options = {}) {
    const item = findItem(resourceId);
    pauseNoteSaving();
    state.loadingResourceToken += 1;
    const draft = options.draft;
    state.noteEditRevision += 1;
    state.noteSyncFailed = Boolean(draft?.syncFailed);
    elements["note-answer"].value = draft ? draft.answer : "";
    state.noteBaseline = draft ? draft.baseline : "";
    state.noteSHA = draft?.sha;
    state.preservedNoteDraft = Boolean(draft);
    state.noteReady = false;
    state.noteOrganization = null;
    elements['note-organization'].hidden = true;
    elements['note-organization-retry'].hidden = true;
    const scope = noteScope();
    setNoteControls();
    if (state.readOnly) { elements["note-status"].textContent = "记录未连接"; return; }
    if (!item || !String(item.exercise || "").trim()) return;

    elements["note-answer"].disabled = true;
    elements["save-note"].disabled = true;
    elements["note-status"].textContent = "正在读取已保存的回答…";
    try {
      const data = await api(
        `/api/notes?module=${encodeURIComponent(state.module)}&resource_id=${encodeURIComponent(resourceId)}`,
        { preserveVersion: Boolean(draft) },
      );
      if (!currentNoteScope(scope)) return;
      if (draft) {
        if (window.HUB_REMOTE?.kind === "shared") {
          if (draft.sha === undefined) throw new Error("草稿原版本不可用。");
          window.HUB_REMOTE.acceptNoteSnapshot(state.module, resourceId, { sha: draft.sha });
          if (data?.sha !== draft.sha) state.noteSyncFailed = true;
        }
      } else {
        elements["note-answer"].value = data && typeof data.answer === "string" ? data.answer : "";
        state.noteBaseline = elements["note-answer"].value;
        state.noteSHA = data?.sha;
      }
      state.noteReady = true;
      organizeAnswer(data?.organization, scope);
      state.preservedNoteDraft = false;
      elements["note-status"].textContent = draft ? state.noteSyncFailed
        ? data?.sha !== draft.sha ? "共享回答已更新；草稿已保留，保存时会检查原版本。"
          : "草稿已保留，请重试保存。" : "已保留尚未保存的回答。"
        : elements["note-answer"].value
        ? "已载入你上次保存的回答。"
        : window.HUB_REMOTE?.kind === "shared" ? "修改后自动保存到共享记录。" : "回答保存在本机；发送问题时，会连同当前资料用于讨论。";
    } catch (error) {
      if (!(error instanceof AuthRequiredError) && currentNoteScope(scope)) {
        elements["note-status"].textContent = "暂时无法读取回答。为保护已有笔记，请刷新重试后再编辑。";
      }
    } finally {
      if (currentNoteScope(scope)) {
        setNoteControls();
        scheduleNoteSave();
      }
    }
  }

  function organizeAnswer(organization, scope) {
    if (!organization || state.readOnly || !currentNoteScope(scope)) return;
    state.noteOrganization = organization;
    const show = result => {
      if (state.readOnly || !currentNoteScope(scope)
          || state.noteOrganization?.source_sha256 !== result.source_sha256) return;
      state.noteOrganization = result;
      const label = window.HUB_RECORD_PREVIEW.describe({ organization: result }, '练习回答');
      const failed = ['FAILED', 'UNKNOWN', 'UNAVAILABLE', 'INVALID'].includes(result.status);
      elements['note-organization'].hidden = (!label.generated && !failed) || noteIsDirty();
      elements['note-organization'].textContent = label.generated ? `${label.title} · ${label.summary}` : label.summary;
      elements['note-organization-retry'].hidden = noteIsDirty() || !(result.retry_known_failure || result.retry_allowed);
      elements['note-organization-retry'].onclick = () => {
        if (currentNoteScope(scope) && !noteIsDirty() && state.noteOrganization?.source_sha256 === result.source_sha256) {
          organizer.retry({ module: scope.module, kind: 'answer', resource_id: scope.resourceId }, state.noteOrganization, show);
        }
      };
    };
    show(organization);
    organizer.schedule({ module: scope.module, kind: 'answer', resource_id: scope.resourceId }, organization, show);
  }

  async function saveNote(options = {}) {
    const resourceId = state.selectedId;
    const automatic = options.automatic === true;
    if (state.readOnly || elements["app-shell"].hidden || !resourceId || !state.noteReady
        || state.savingNote || state.noteComposing || automatic && !canAutoSaveNote()) return false;
    clearNoteSaveTimer();
    if (!noteIsDirty()) return true;
    const answer = elements["note-answer"].value;
    state.noteSaveToken += 1;
    const scope = noteScope();
    state.savingNote = true;
    setNoteControls();
    elements["note-status"].textContent = "正在保存回答…";
    try {
      const saved = await api("/api/notes", {
        method: "PUT",
        body: {
          module: scope.module,
          resource_id: resourceId,
          answer,
        },
      });
      if (!currentNoteScope(scope)) return false;
      if (window.HUB_REMOTE?.kind === "shared" && saved?.sha === undefined) {
        throw new Error("共享记录未返回保存版本。");
      }
      state.noteBaseline = answer;
      state.noteSHA = saved?.sha;
      organizeAnswer(saved?.organization, scope);
      state.noteSyncFailed = false;
      state.noteEditRevision += 1;
      elements["note-status"].textContent = noteIsDirty()
        ? window.HUB_REMOTE?.kind === "shared" ? "刚才的版本已保存；新修改待同步。" : "刚才的版本已保存；新修改还没有保存。"
        : window.HUB_REMOTE?.kind === "shared" ? "已同步。" : "已保存到你的私有 Hub。";
      if (!automatic) notify("回答已保存");
      return !noteIsDirty();
    } catch (error) {
      if (currentNoteScope(scope)) {
        state.noteSyncFailed = true;
        elements["note-status"].textContent = `${error.message || "保存未完成。"} 草稿已保留，可重试。`;
      }
      return false;
    } finally {
      if (currentNoteScope(scope)) {
        state.savingNote = false;
        setNoteControls();
        scheduleNoteSave();
      }
    }
  }

  async function refreshSessions() {
    if (state.readOnly) return;
    const token = state.authRequestToken;
    try {
      const data = await api(`/api/sessions?module=${encodeURIComponent(state.module)}`);
      if (state.readOnly || token !== state.authRequestToken) return;
      state.sessions = Array.isArray(data) ? data : [];
      renderSessions();
    } catch (error) {
      if (state.readOnly || token !== state.authRequestToken) return;
      if (error instanceof AuthRequiredError) throw error;
      renderSessions("历史对话暂时无法读取。");
    }
  }

  function renderSessions(errorMessage) {
    elements["session-list"].replaceChildren();
    elements["session-count"].textContent = String(state.sessions.length);
    if (errorMessage || !state.sessions.length) {
      elements["session-list"].append(
        make("p", "empty-list", state.readOnly ? "记录未连接" : errorMessage || "还没有历史对话。"),
      );
      return;
    }

    state.sessions.forEach((session) => {
      const row = make('div', 'session-row');
      const button = make("button", "session-button");
      button.type = "button";
      button.disabled = state.sending || Boolean(state.deletingSession);
      button.dataset.sessionId = session.id;
      button.classList.toggle("active", session.id === state.sessionId);
      if (session.id === state.sessionId) button.setAttribute("aria-current", "true");
      const label = window.HUB_RECORD_PREVIEW.conversation(session);
      button.append(make("strong", "record-title", label.title));
      if (label.summary) button.append(make("span", "record-summary", label.summary));
      button.append(make("span", "record-source", resourceTitle(session.resource_id)));
      button.setAttribute("aria-label", `${label.title}，${resourceTitle(session.resource_id)}`);
      const remove = make('button', 'session-delete', state.deletingSession === session.id ? '删除中…' : '删除');
      remove.type = 'button';
      remove.dataset.deleteSession = session.id;
      remove.setAttribute('aria-label', `删除对话：${label.title}`);
      remove.disabled = state.readOnly || state.sending || Boolean(state.deletingSession);
      row.append(button);
      if (window.HUB_REMOTE?.kind === 'shared') row.append(remove);
      elements["session-list"].append(row);
      const authRevision = state.authRequestToken;
      organizer.schedule({ module: state.module, kind: 'session', resource_id: session.resource_id, record_id: session.id },
        session.organization, result => {
          if (state.readOnly || authRevision !== state.authRequestToken || !state.sessions.includes(session)
              || session.organization?.source_sha256 !== result.source_sha256) return;
          session.organization = result;
          renderSessions();
        });
      if (session.organization?.retry_known_failure || session.organization?.retry_allowed) {
        const retry = make('button', 'session-retry', '重试整理'); retry.type = 'button';
        retry.addEventListener('click', () => organizer.retry({ module: state.module, kind: 'session',
          resource_id: session.resource_id, record_id: session.id }, session.organization, result => {
          if (state.readOnly || authRevision !== state.authRequestToken || !state.sessions.includes(session)
              || session.organization?.source_sha256 !== result.source_sha256) return;
          session.organization = result;
          renderSessions();
        }));
        elements['session-list'].append(retry);
      }
    });
  }

  async function createSession(resourceId) {
    if (state.readOnly) throw new Error("记录未连接。");
    if (!resourceId) throw new Error("请先选择一项资料。");
    const data = await api("/api/sessions", {
      method: "POST",
      body: { module: state.module, resource_id: resourceId },
    });
    await refreshSessions();
    return data.id;
  }

  async function deleteConversation(sessionId) {
    if (state.readOnly || state.sending || state.deletingSession) return;
    const session = state.sessions.find(item => item.id === sessionId);
    if (!session?.sha) { setChatStatus('请刷新历史列表后再删除。', true); return; }
    if (!window.confirm('删除这段对话？后台版本记录仍会保留。')) return;
    const authToken = state.authRequestToken, module = state.module;
    ++state.sessionLoadToken;
    state.deletingSession = sessionId;
    renderSessions(); disableComposer(true);
    setChatStatus('正在同步删除…');
    try {
      const result = await api(`/api/sessions/${sessionId}`, { method: 'DELETE',
        body: { module, expected_sha: session.sha } });
      if (state.readOnly || authToken !== state.authRequestToken || module !== state.module) return;
      if (result.id !== sessionId || !result.deleted_at || !result.sha) throw new Error('删除结果不完整，请刷新历史列表核对。');
      state.sessions = state.sessions.filter(item => item.id !== sessionId);
      if (state.sessionId === sessionId) clearCurrentConversation();
      renderSessions();
      setChatStatus('对话已删除并同步');
    } catch (error) {
      if (!state.readOnly && authToken === state.authRequestToken && module === state.module) {
        if (!(error instanceof AuthRequiredError)) setChatStatus(error.message || '删除未完成，请刷新历史列表核对。', true);
      }
    } finally {
      state.deletingSession = null;
      renderSessions(); disableComposer(state.sending);
    }
  }

  async function startNewConversation() {
    if (state.readOnly || !state.selectedId || state.sending || state.deletingSession) return;
    const resourceId = state.selectedId;
    const operationToken = ++state.chatRequestToken;
    const sessionToken = ++state.sessionLoadToken;
    elements["new-session"].disabled = true;
    setChatStatus("正在新建对话…");
    try {
      const sessionId = await createSession(resourceId);
      if (
        operationToken !== state.chatRequestToken ||
        sessionToken !== state.sessionLoadToken ||
        resourceId !== state.selectedId
      ) return;
      state.sessionId = sessionId;
      state.sessionResourceId = resourceId;
      renderMessages([]);
      renderSessions();
      setChatStatus("新对话已建立");
      elements["chat-input"].focus();
    } catch (error) {
      if (!(error instanceof AuthRequiredError)) setChatStatus(error.message || "新建对话失败。", true);
    } finally {
      elements["new-session"].disabled = false;
    }
  }

  async function loadSession(sessionId) {
    if (state.readOnly || !sessionId || state.sending || state.deletingSession) return;
    const operationToken = ++state.sessionLoadToken;
    setChatStatus("正在读取对话…");
    disableComposer(true);
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (operationToken !== state.sessionLoadToken) return;
      if (data.module && data.module !== state.module) {
        throw new Error("这条对话不属于当前模块。" );
      }
      if (data.resource_id && findItem(data.resource_id)) {
        if (!await selectResource(data.resource_id, { updateUrl: true, fromSession: true })) {
          setChatStatus("已保留当前回答，未切换对话。");
          return;
        }
      }
      if (operationToken !== state.sessionLoadToken) return;
      state.sessionId = data.id;
      state.sessionResourceId = data.resource_id || state.selectedId;
      const listed = state.sessions.find(item => item.id === data.id);
      if (listed) listed.messages = Array.isArray(data.messages) ? data.messages : [];
      renderMessages(Array.isArray(data.messages) ? data.messages : []);
      renderSessions();
      elements["history-drawer"].open = false;
      setChatStatus("");
    } catch (error) {
      if (!(error instanceof AuthRequiredError)) setChatStatus(error.message || "对话读取失败。", true);
    } finally {
      disableComposer(false);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const message = elements["chat-input"].value.trim();
    if (state.readOnly || !state.discussionReady || !message || !state.selectedId || state.sending) return;

    const resourceId = state.selectedId;
    const requestToken = ++state.chatRequestToken;
    let sessionId = state.sessionId;
    state.sending = true;
    disableComposer(true);
    setChatStatus("正在思考…");
    const optimisticMessage = appendMessage({ role: "user", content: message });
    elements["chat-input"].value = "";
    const pending = appendPendingMessage();

    try {
      if (!sessionId || state.sessionResourceId !== resourceId) {
        sessionId = await createSession(resourceId);
        if (requestToken !== state.chatRequestToken || resourceId !== state.selectedId) return;
        state.sessionId = sessionId;
        state.sessionResourceId = resourceId;
      }
      const data = await api("/api/chat", {
        method: "POST",
        body: { session_id: sessionId, message, model: elements["discussion-model"].value,
          reasoning_effort: elements["discussion-effort"].value || undefined },
      });
      if (requestToken !== state.chatRequestToken || resourceId !== state.selectedId) return;
      pending.remove();
      appendMessage({ role: "assistant", content: data.reply || "", model: data.model, reasoning_effort: data.reasoning_effort });
      setChatStatus(contextDescription(data.context_ids));
      await refreshSessions();
    } catch (error) {
      pending.remove();
      if (requestToken === state.chatRequestToken && resourceId === state.selectedId) {
        optimisticMessage.remove();
        elements["chat-input"].value = message;
        if (error instanceof AuthRequiredError) return;
        const reason = error.message || "发送失败，请稍后重试。";
        appendMessage({
          role: "assistant",
          content: `这次回复没有完成：${reason} 问题已保留在输入框，可直接重试。`,
        }, true);
        setChatStatus(reason, true);
      }
    } finally {
      state.sending = false;
      disableComposer(false);
      if (requestToken === state.chatRequestToken) elements["chat-input"].focus();
    }
  }

  function clearCurrentConversation() {
    state.chatRequestToken += 1;
    state.sessionId = null;
    state.sessionResourceId = null;
    renderMessages([]);
    renderSessions();
    setChatStatus("");
  }

  function renderMessages(messages) {
    elements["chat-messages"].replaceChildren();
    if (!messages.length) {
      const welcome = make("div", "chat-welcome");
      const selected = findItem(state.selectedId);
      welcome.append(make(
        "p",
        "",
        selected
          ? "哪一步还没想清楚？"
          : "选择资料，开始讨论。",
      ));
      if (selected) {
        const prompts = make("div", "discussion-prompts");
        for (const [action, label] of [["explain", "讲清推理"], ["evidence", "追问依据"], ["transfer", "换个情境"]]) {
          const button = make("button", "", label);
          button.type = "button";
          button.addEventListener("click", () => {
            if (state.readOnly || state.sending) return;
            if (elements["chat-input"].value.trim() && !window.confirm("替换输入框里尚未发送的问题吗？")) return;
            const index = Number(elements["study-section"].value);
            const section = state.bookStudy?.sections[index] || state.studySections[index];
            if (!section) { notify("请先选择要讨论的正文章节。"); return; }
            elements["chat-input"].value = window.HUB_STUDY.question(selected,
              { ...section, position: index + 1 }, action);
            elements["chat-input"].focus();
          });
          prompts.append(button);
        }
        welcome.append(prompts);
      }
      elements["chat-messages"].append(welcome);
      return;
    }
    messages.forEach((message) => appendMessage(message));
    scrollChat();
  }

  function appendMessage(message, isError) {
    const role = message.role === "user" ? "user" : "assistant";
    const wrapper = make("div", `message ${role}${isError ? " error" : ""}`);
    const choice = state.discussionModels.find(item => item.id === message.model);
    const depth = effortLabel(message.reasoning_effort);
    wrapper.append(make("span", "message-label", role === "user" ? "你"
      : (choice?.label || message.model || "知识助手") + (depth ? ` · ${depth}` : "")));
    const bubble = make("div", "message-bubble");
    if (role === "assistant") renderStructuredText(bubble, assistantDisplayText(String(message.content || "")));
    else bubble.textContent = String(message.content || "");
    wrapper.append(bubble);
    elements["chat-messages"].append(wrapper);
    scrollChat();
    return wrapper;
  }

  function appendPendingMessage() {
    const wrapper = make("div", "message assistant pending");
    wrapper.append(make("span", "message-label", "知识助手"));
    const bubble = make("div", "message-bubble");
    bubble.setAttribute("aria-label", "正在生成回复");
    for (let index = 0; index < 3; index += 1) bubble.append(make("span", "typing-dot"));
    wrapper.append(bubble);
    elements["chat-messages"].append(wrapper);
    scrollChat();
    return wrapper;
  }

  function effortLabel(value) {
    return ["low", "medium", "high", "xhigh", "max"].includes(value) ? value : "";
  }

  function configureEfforts(defaultEffort) {
    const selected = state.discussionModels.find(item => item.id === elements["discussion-model"].value);
    const preferred = discussionPreference();
    const previous = defaultEffort || preferred.efforts?.[selected?.id] || selected?.default_effort || 'high';
    elements["discussion-effort"].replaceChildren(...(selected?.efforts || []).map(value => new Option(effortLabel(value) || value, value)));
    elements["discussion-effort"].value = selected?.efforts.includes(previous) ? previous
      : selected?.efforts.includes("high") ? "high" : selected?.efforts[0] || "";
  }

  function discussionPreference() {
    try {
      const current = JSON.parse(localStorage.getItem(`hub-discussion-choice-v4:${state.module}`) || 'null');
      if (current && typeof current === 'object') return current;
      const previous = JSON.parse(localStorage.getItem(`hub-discussion-choice-v3:${state.module}`) || 'null');
      if (previous && typeof previous === 'object') return { model: 'claude-opus-5-5', efforts: previous.efforts || {} };
      const legacy = JSON.parse(localStorage.getItem(`hub-discussion-choice-v2:${state.module}`) || '{}');
      return { model: 'claude-opus-5-5', efforts: legacy.model && legacy.effort && legacy.effort !== 'medium'
        ? { [legacy.model]: legacy.effort } : {} };
    } catch { return {}; }
  }

  function rememberDiscussionChoice() {
    const model = elements['discussion-model'].value;
    try { localStorage.setItem(`hub-discussion-choice-v4:${state.module}`, JSON.stringify({
      model, efforts: { ...discussionPreference().efforts, [model]: elements['discussion-effort'].value },
    })); } catch { /* No records or credentials enter this preference. */ }
  }

  async function loadDiscussionModels(token, publicMode) {
    state.discussionReady = false;
    elements["discussion-options"].hidden = true;
    if (publicMode) return;
    try {
      const catalog = await api("/api/discussion-models");
      if (token !== state.workspaceLoadToken || publicMode !== state.readOnly) return;
      if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error("讨论模型尚未配置。");
      const preferred = discussionPreference();
      const previous = preferred.model;
      state.discussionModels = catalog.models;
      elements["discussion-model"].replaceChildren(...catalog.models.map(item => new Option(item.label, item.id)));
      elements["discussion-model"].value = catalog.models.some(item => item.id === previous) ? previous : catalog.default_model;
      configureEfforts(preferred.efforts?.[elements['discussion-model'].value]
        || catalog.models.find(item => item.id === elements['discussion-model'].value)?.default_effort || 'high');
      state.discussionReady = true;
      elements["discussion-options"].hidden = false;
      disableComposer(state.sending);
    } catch (error) {
      if (token !== state.workspaceLoadToken || publicMode !== state.readOnly) return;
      setChatStatus(error.message || "模型选项暂时无法读取，请重新连接。", true);
    }
  }

  function disableComposer(disabled) {
    disabled = disabled || !state.discussionReady || Boolean(state.deletingSession);
    elements["discussion-model"].disabled = state.readOnly || disabled;
    elements["discussion-effort"].disabled = state.readOnly || disabled;
    elements["chat-input"].disabled = state.readOnly || disabled || !state.selectedId;
    elements["chat-send"].disabled = state.readOnly || disabled || !state.selectedId;
    elements["new-session"].disabled = state.readOnly || disabled || !state.selectedId;
  }

  function setChatStatus(message, isError) {
    elements["chat-status"].textContent = message;
    elements["chat-status"].classList.toggle("error", Boolean(isError));
  }

  function renderNoResources() {
    elements["detail-empty"].replaceChildren(make("p", "", "这个模块还没有可用资料。"));
    elements["detail-empty"].hidden = false;
    elements["detail-content"].hidden = true;
    elements["chat-context"].textContent = "尚未选择资料";
    disableComposer(true);
  }

  function renderWorkspaceError(message) {
    state.items = [];
    renderResourceList();
    elements["detail-empty"].replaceChildren(make("p", "", message));
    elements["detail-empty"].hidden = false;
    elements["detail-content"].hidden = true;
    disableComposer(true);
  }

  async function api(path, options) {
    const settings = options || {};
    const method = (settings.method || "GET").toUpperCase();
    if (state.readOnly && !(method === "GET" && (path.startsWith("/api/catalog?")
        || /^\/api\/reading\/[a-z0-9_-]+\/study$/.test(path))) && path !== "/api/login") {
      throw new Error("记录未连接。");
    }
    const headers = { Accept: "application/json" };
    const request = {
      method,
      headers,
      credentials: "same-origin",
    };

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers["X-Hub-Request"] = "1";
    }
    if (Object.prototype.hasOwnProperty.call(settings, "body")) {
      headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(settings.body);
    }
    if (settings.preserveVersion) request.preserveVersion = true;

    let response;
    try {
      response = window.HUB_REMOTE ? await window.HUB_REMOTE.request(path, request) : await fetch(path, request);
    } catch (error) {
      if (window.HUB_REMOTE) throw error;
      throw new Error("无法连接服务器，请检查网络后重试。");
    }

    if (response.status === 401) {
      if (!settings.allowUnauthenticated) showLogin(window.HUB_REMOTE?.kind === "shared"
        ? "会话已过期，请重新输入用户名。" : window.HUB_REMOTE
          ? "GitHub 连接已过期，请重新连接。" : "会话已过期，请重新输入用户名。");
      throw new AuthRequiredError("需要登录");
    }

    const data = await readResponse(response);
    if (!response.ok) {
      const message = data && (data.detail || data.message || data.error);
      throw new Error(typeof message === "string" ? message : `请求失败（${response.status}）`);
    }
    return data;
  }

  async function readResponse(response) {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return text;
    }
  }

  function moduleFromPath() {
    const segment = window.location.pathname.replace(/\/+$/, "").split("/").pop();
    return Object.prototype.hasOwnProperty.call(MODULES, segment) ? segment : "reading";
  }

  function findItem(resourceId) {
    return state.items.find((item) => item.id === resourceId);
  }

  function resourceTitle(resourceId) {
    const item = findItem(resourceId);
    return item ? item.title || "当前资料" : "历史资料";
  }

  function normalize(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
  }

  function preview(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 64);
  }

  function make(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function assistantDisplayText(source) {
    // Repair lost block boundaries for display only. Stored replies and source
    // materials retain their exact bytes; code and inline tokens stay literal.
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    let fence = null;
    let table = false;
    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      if (fence) {
        output.push(line);
        if (new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
        continue;
      }
      if (table && !line.trim().startsWith("|")) {
        output.push("");
        table = false;
      }
      // A glued fence must follow sentence punctuation and end with a language
      // identifier. Never split an inline fenced literal or a code line.
      line = line.replace(/([。！？；：])(`{3,}|~{3,})([a-zA-Z0-9_-]*)\s*$/, "$1\n\n$2$3");
      const tokens = /(`+)[^`]*?\1|!?\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g;
      let position = 0;
      let normalized = "";
      const boundaries = text => text.replace(/([。！？；：])(?=(?:#{1,6}\s+|[-*+]\s+|\d{1,2}[.)]\s+|>\s+))/g, "$1\n");
      for (const token of line.matchAll(tokens)) {
        normalized += boundaries(line.slice(position, token.index)) + token[0];
        position = token.index + token[0].length;
      }
      normalized += boundaries(line.slice(position));
      // A valid table separator identifies a header, even when preceding prose
      // lost its newline. Other vertical bars remain ordinary text.
      if (/^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[index + 1] || "")) {
        const pipe = normalized.indexOf("|");
        output.push("");
        if (pipe > 0 && normalized.slice(0, pipe).trim()) {
          normalized = normalized.slice(0, pipe) + "\n\n" + normalized.slice(pipe);
        }
        table = normalized.split("\n").at(-1).trim().startsWith("|");
      }
      output.push(normalized);
      const opening = normalized.split("\n").at(-1).trim().match(/^(`{3,}|~{3,})[a-zA-Z0-9_-]*\s*$/);
      if (opening) fence = opening[1];
    }
    return output.join("\n");
  }

  function renderStructuredText(container, source) {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    let index = 0;

    while (index < lines.length) {
      const raw = lines[index];
      const trimmed = raw.trim();
      if (!trimmed) {
        index += 1;
        continue;
      }

      const fence = trimmed.match(/^(`{3,}|~{3,})/);
      if (fence) {
        const code = [];
        const closing = new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`);
        index += 1;
        while (index < lines.length && !closing.test(lines[index].trim())) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        container.append(make("pre", "", code.join("\n")));
        continue;
      }

      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const label = cleanInline(heading[2]);
        const kind = ["作者的论述", "背景", "后来的评估", "阅读推论"].includes(label);
        container.append(make(heading[1].length <= 2 ? "h3" : "h4", kind ? "knowledge-kind" : "", label));
        index += 1;
        continue;
      }

      // Explicit stand-alone resource links preserve continuous reading and
      // open separately, leaving the selected context and unsaved answer intact.
      const resourceLink = trimmed.match(/^\[([^\]]+)\]\(([^\s]+)\)$/);
      const resourceHref = resourceLink && safeHref(resourceLink[2]);
      if (resourceHref) {
        const paragraph = make("p");
        const link = make("a", "", resourceLink[1] + " ↗");
        link.href = moduleHref(resourceHref);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        paragraph.append(link);
        container.append(paragraph);
        index += 1;
        continue;
      }

      if (/^[-*+]\s+/.test(trimmed)) {
        const list = make("ul");
        while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
          list.append(make("li", "", cleanInline(lines[index].replace(/^\s*[-*+]\s+/, ""))));
          index += 1;
        }
        container.append(list);
        continue;
      }

      if (/^\d+[.)]\s+/.test(trimmed)) {
        const list = make("ol");
        while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
          list.append(make("li", "", cleanInline(lines[index].replace(/^\s*\d+[.)]\s+/, ""))));
          index += 1;
        }
        container.append(list);
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        const quote = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        container.append(make("blockquote", "", cleanInline(quote.join("\n"))));
        continue;
      }

      const paragraph = [];
      while (index < lines.length && lines[index].trim()) {
        const next = lines[index].trim();
        if (paragraph.length && (/^(`{3,}|~{3,})/.test(next) || /^(#{1,6})\s+/.test(next) || /^[-*+]\s+/.test(next) || /^\d+[.)]\s+/.test(next) || /^>\s?/.test(next))) break;
        paragraph.push(next);
        index += 1;
      }
      const isClaim = /^\[[^\]]+\]\s+[A-Z_]+/.test(paragraph[0] || "");
      const table = window.HUB_STUDY.table(paragraph);
      if (paragraph[0]?.startsWith("试讲范围：")) {
        container.append(make("p", "lesson-scope", paragraph.join(" ")));
      } else if (paragraph[0]?.startsWith("依据：")) {
        const item = findItem(state.selectedId);
        const identity = paragraph[0].slice("依据：".length).split(" · ")[0];
        const claim = item?.evidence?.claims?.find(entry => entry.claim_id === identity);
        const evidence = make("p", "claim-reference", "依据 ");
        const claimAnchor = window.HUB_EVIDENCE.claimId(identity);
        if (!document.getElementById(claimAnchor) && ![...container.children].some(child => child.id === claimAnchor)) {
          const heading = [...container.children].reverse().find(child => child.classList.contains("knowledge-kind"));
          (heading || evidence).id = claimAnchor;
        }
        if (state.module === "reading" && claim) {
          (claim.citation_ids || []).forEach(id => {
            const citation = item.evidence.citations?.find(entry => entry.citation_id === id);
            const number = item.evidence.citations.findIndex(entry => entry.citation_id === id) + 1;
            const link = make("a", "citation-jump", `[${number || id}]`);
            link.href = `#${window.HUB_EVIDENCE.citationId(id)}`;
            link.title = citation?.locator || id;
            link.setAttribute("aria-label", `引文 ${number || id}：${citation?.locator || "待核对"}`);
            evidence.append(link);
          });
          if (!claim.citation_ids?.length) evidence.append(document.createTextNode("未附引文；请留意正文的推论边界。"));
        } else evidence.append(document.createTextNode(paragraph.join(" ")));
        container.append(evidence);
      } else if (table) {
        const rendered = make("table", "study-table");
        rendered.setAttribute("aria-label", "资料对照表");
        const head = make("thead");
        const headings = make("tr");
        table.header.forEach(label => {
          const th = make("th", "", cleanInline(label));
          th.scope = "col";
          headings.append(th);
        });
        head.append(headings);
        const body = make("tbody");
        table.rows.forEach(row => {
          const tr = make("tr");
          row.forEach((value, index) => {
            const td = make("td");
            const label = make("span", "cell-label", cleanInline(table.header[index]));
            label.setAttribute("aria-hidden", "true");
            const content = make("span", "cell-value");
            renderTableValue(content, value);
            td.append(label, content);
            tr.append(td);
          });
          body.append(tr);
        });
        rendered.append(head, body);
        container.append(rendered);
      } else {
        container.append(make("p", isClaim ? "claim-block" : "", cleanInline(paragraph.join(isClaim ? "\n" : " "))));
      }
    }
  }

  function renderTableValue(container, value) {
    // Recognize the existing Markdown-link subset without interpreting HTML or
    // links inside code/image tokens. Everything else keeps its plain-text form.
    const text = String(value);
    const tokens = /`[^`]+`|!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let position = 0;
    for (const token of text.matchAll(tokens)) {
      container.append(document.createTextNode(cleanInline(text.slice(position, token.index))));
      let href = null;
      if (token[1]) {
        try {
          const target = new URL(token[2], window.location.origin);
          if (!target.username && !target.password) href = safeHref(token[2]);
        } catch { /* Invalid links retain their inert text. */ }
      }
      if (href) {
        const label = cleanInline(token[1]);
        const link = make("a", "", label);
        link.href = moduleHref(href);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.setAttribute("aria-label", `${label}（新标签页）`);
        container.append(link);
      } else container.append(document.createTextNode(cleanInline(token[0])));
      position = token.index + token[0].length;
    }
    container.append(document.createTextNode(cleanInline(text.slice(position))));
  }

  function cleanInline(value) {
    return String(value)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  }

  function safeHref(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    try {
      const url = new URL(raw.trim(), window.location.origin);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.origin === window.location.origin
        ? `${url.pathname}${url.search}${url.hash}`
        : url.href;
    } catch (error) {
      return null;
    }
  }

  function isExternalHref(href) {
    try {
      return new URL(href, window.location.origin).origin !== window.location.origin;
    } catch (error) {
      return false;
    }
  }

  function updateResourceUrl(resourceId) {
    const url = new URL(window.location.href);
    url.searchParams.set("resource", resourceId);
    url.hash = "";
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function modelDescription(model, effort) {
    if (!model && !effort) return "";
    const parts = [];
    if (model) parts.push(String(model));
    if (effort) parts.push(`推理强度 ${String(effort)}`);
    return parts.join(" · ");
  }

  function contextDescription(contextIds) {
    const count = Array.isArray(contextIds) ? contextIds.length : 0;
    return count ? `已参考 ${count} 项上下文` : "回复完成";
  }

  function setCatalogStatus(message) {
    elements["catalog-status"].textContent = message;
  }

  function scrollChat() {
    window.requestAnimationFrame(() => {
      elements["chat-messages"].scrollTop = elements["chat-messages"].scrollHeight;
    });
  }

  function notify(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 2400);
  }
})();
