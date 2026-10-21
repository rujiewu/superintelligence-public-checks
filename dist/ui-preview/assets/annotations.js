/* Reading comments use exact quote selectors; they never become chat context. */
window.HUB_TEXT_ANCHOR = (() => {
  function locate(text, anchor) {
    if (!anchor?.quote) return null;
    const matches = [];
    for (let start = text.indexOf(anchor.quote); start >= 0; start = text.indexOf(anchor.quote, start + 1)) {
      const end = start + anchor.quote.length;
      if ((!anchor.prefix || text.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix)
          && (!anchor.suffix || text.slice(end, end + anchor.suffix.length) === anchor.suffix)) matches.push({ start, end });
    }
    return matches.length === 1 ? matches[0] : null;
  }
  function blocks(section) {
    return [...section.querySelectorAll('p,blockquote,li,pre,td,h2,h3,h4')]
      .filter(node => !node.querySelector('p,blockquote,li,pre,td,h2,h3,h4')
        && !node.closest('button,.section-discussion,.book-discuss,.annotation-notes'));
  }
  function range(block, offsets) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const result = document.createRange();
    let node, offset = 0, begun = false;
    while ((node = walker.nextNode())) {
      const end = offset + node.textContent.length;
      if (!begun && offsets.start <= end) {
        result.setStart(node, Math.max(0, offsets.start - offset)); begun = true;
      }
      if (begun && offsets.end <= end) { result.setEnd(node, offsets.end - offset); return result; }
      offset = end;
    }
    return null;
  }
  function resolve(roots, anchor) {
    if (!anchor) return null;
    const section = roots.map(root => root.id === anchor.section_id ? root
      : root.querySelector('[id="' + CSS.escape(anchor.section_id) + '"]'))
      .find(Boolean);
    if (!section) return null;
    const candidates = blocks(section).map(block => ({ block, offsets: locate(block.textContent, anchor) }))
      .filter(value => value.offsets);
    // Even a matching old index is insufficient if the quote is now ambiguous.
    return candidates.length === 1 ? range(candidates[0].block, candidates[0].offsets) : null;
  }
  function capture(roots) {
    for (const root of roots) {
      const selection = root.getSelection?.() || window.getSelection();
      if (!selection || !selection.rangeCount || selection.isCollapsed) continue;
      const selected = selection.getRangeAt(0);
      const parent = selected.startContainer.nodeType === 1 ? selected.startContainer : selected.startContainer.parentElement;
      const block = parent?.closest('p,blockquote,li,pre,td,h2,h3,h4');
      if (!block || !root.contains(block) || !block.contains(selected.endContainer)) continue;
      const enclosing = block.closest('section[id]');
      const section = enclosing && root.contains(enclosing) ? enclosing : root;
      if (!section.id) continue;
      const blockIndex = blocks(section).indexOf(block);
      if (blockIndex < 0) continue;
      const quote = selected.toString();
      if (!quote.trim() || quote.length > 2000) continue;
      const prefix = document.createRange();
      prefix.selectNodeContents(block); prefix.setEnd(selected.startContainer, selected.startOffset);
      const start = prefix.toString().length, end = start + quote.length;
      return { section_id: section.id, block_index: blockIndex, quote,
        start, prefix: block.textContent.slice(Math.max(0, start - 120), start),
        suffix: block.textContent.slice(end, end + 120), rectangle: selected.getBoundingClientRect() };
    }
    return null;
  }
  return Object.freeze({ locate, resolve, capture });
})();

window.HUB_ANNOTATIONS = ({ api, connected, notify, organizer }) => {
  const get = id => document.getElementById(id);
  const panel = get('annotation-notes'), list = get('annotation-list'), status = get('annotation-status');
  const add = get('add-reading-note'), selectButton = get('annotate-selection');
  const dialog = get('annotation-dialog'), quote = get('annotation-quote'), input = get('annotation-comment');
  const save = get('save-reading-note'), reload = get('reload-reading-notes'), error = get('annotation-error');
  let material = null, roots = [], sourceSHA = '', entries = [], working = null;
  let ready = false, saving = false, needsMerge = false, recordSHA = null, sequence = 0, selected = null, timer;
  let saveTimer, composing = false, autoPaused = false;
  const make = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const isDirty = () => Boolean(working && input.value !== working.baseline);
  const closeEditor = () => { clearTimeout(saveTimer); dialog.hidden = true; list.hidden = false; };
  const openEditor = () => { dialog.hidden = false; list.hidden = true;
    window.dispatchEvent(new CustomEvent('hub-annotation-open')); };
  function controls() {
    const disabled = !connected() || !ready || saving;
    add.disabled = disabled; save.disabled = disabled || needsMerge;
    reload.disabled = !connected() || saving;
    selectButton.hidden = disabled || !selected;
    list.querySelectorAll('button').forEach(button => { button.disabled = disabled; });
  }
  function highlights() {
    if (!CSS.highlights || typeof Highlight !== 'function') return;
    const ranges = entries.map(entry => window.HUB_TEXT_ANCHOR.resolve(roots, entry.anchor)).filter(Boolean);
    CSS.highlights.set('hub-reading-note', new Highlight(...ranges));
  }
  function render() {
    list.replaceChildren();
    if (!entries.length) list.append(make('p', '还没有学习笔记。可以在正文选中文字，记下自己的想法。', 'annotation-empty'));
    for (const entry of entries) {
      const card = make('article', '', 'reading-note');
      card.dataset.noteId = entry.id;
      const heading = make('div', '', 'reading-note-heading');
      const label = window.HUB_RECORD_PREVIEW.annotation(entry);
      const edit = make('button', '', 'reading-note-body'); edit.type = 'button';
      edit.title = '编辑笔记'; edit.setAttribute('aria-label', '编辑笔记：' + label.title);
      edit.append(make('strong', label.title, 'reading-note-title'));
      if (label.summary) edit.append(make('span', label.summary, 'record-summary'));
      edit.addEventListener('click', () => open(entry)); heading.append(edit);
      const remove = make('button', '删除', 'reading-note-delete'); remove.type = 'button';
      remove.setAttribute('aria-label', '删除这条笔记');
      remove.addEventListener('click', () => removeEntry(entry)); heading.append(remove); card.append(heading);
      if (entry.organization?.retry_known_failure || entry.organization?.retry_allowed) {
        const retry = make('button', '重试整理', 'reading-note-delete'); retry.type = 'button';
        retry.addEventListener('click', () => scheduleOrganization(entry, true));
        heading.append(retry);
      }
      if (entry.anchor) {
        const jump = make('button', entry.anchor.quote, 'reading-note-quote'); jump.type = 'button';
        jump.title = '回到原文'; jump.setAttribute('aria-label', '回到这条笔记对应的原文');
        jump.addEventListener('click', () => {
          const found = window.HUB_TEXT_ANCHOR.resolve(roots, entry.anchor);
          if (!found) { notify('正文已变化，暂时无法唯一定位；笔记与原摘录仍保留。'); return; }
          window.dispatchEvent(new CustomEvent('hub-annotation-jump'));
          window.HUB_BOOK_STUDY?.reveal(found.startContainer.parentElement);
          found.startContainer.parentElement.scrollIntoView({ block: 'center' });
          if (entry.anchor.source_sha256 !== sourceSHA) notify('这条笔记来自较早版本，已按摘录定位，请核对上下文。');
        });
        card.append(jump);
      }
      list.append(card);
      scheduleOrganization(entry);
    }
    highlights();
  }
  function scheduleOrganization(entry, retry = false) {
      const current = material, ticket = sequence;
      const method = retry ? organizer?.retry : organizer?.schedule;
      method?.({ module: current.module, kind: 'annotation', resource_id: current.id, record_id: entry.id },
        entry.organization, result => {
          if (material !== current || ticket !== sequence || !connected() || !entries.includes(entry)
              || entry.organization?.source_sha256 !== result.source_sha256) return;
          entry.organization = result;
          render();
        });
  }
  async function load() {
    const current = material, ticket = ++sequence;
    ready = false; controls(); status.textContent = '正在读取笔记…';
    try {
      const data = await api(`/api/annotations?module=${encodeURIComponent(current.module)}&resource_id=${encodeURIComponent(current.id)}`);
      if (ticket !== sequence || material !== current || !connected()) return;
      if (!Array.isArray(data.entries) || !Object.prototype.hasOwnProperty.call(data, 'sha')) throw new Error('笔记缺少完整版本，暂时不能保存。');
      entries = data.entries; recordSHA = data.sha; ready = true; render(); status.textContent = entries.length ? `${entries.length} 条学习笔记` : '';
    } catch (failure) {
      if (ticket === sequence && material === current) status.textContent = `${failure.message || '笔记暂未读取。'} 草稿仍保留。`;
    } finally { if (ticket === sequence) controls(); }
  }
  function open(entry = null, anchor = null) {
    if (!ready || !connected() || saving) return;
    if (isDirty() && !window.confirm('笔记尚未保存，放弃修改并编辑另一条笔记吗？')) return;
    working = { id: entry?.id || crypto.randomUUID().replaceAll('-', ''), anchor: entry?.anchor || anchor,
      revision: entry?.revision || null, baseline: entry?.comment || '', material };
    clearTimeout(saveTimer); autoPaused = false; composing = false;
    input.value = working.baseline; quote.textContent = working.anchor?.quote || '整篇资料的笔记';
    needsMerge = false; get('merge-reading-note').hidden = true; get('annotation-latest').textContent = '';
    error.textContent = ''; reload.hidden = true; controls(); openEditor(); input.focus();
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    if (!working || !isDirty() || !input.value.trim() || saving || composing || autoPaused || needsMerge || !ready || !connected()) return;
    saveTimer = setTimeout(() => submit(null, { automatic: true }), 2500);
  }
  async function submit(event, { automatic = false } = {}) {
    event?.preventDefault();
    clearTimeout(saveTimer);
    if (automatic && (autoPaused || composing || !isDirty())) return;
    if (!working || saving || needsMerge || !ready || !connected() || !input.value.trim()) return;
    if (!automatic && !isDirty() && working.revision) { closeEditor(); working = null; controls(); return; }
    const draft = { ...working, comment: input.value }, ticket = sequence;
    saving = true; controls(); error.textContent = '正在保存…';
    try {
      const data = await api('/api/annotations', { method: 'PUT', body: { module: draft.material.module,
        resource_id: draft.material.id, id: draft.id, anchor: draft.anchor, comment: draft.comment,
        expected_sha: recordSHA, expected_revision: draft.revision } });
      if (ticket !== sequence || material !== draft.material || !connected()) return;
      if (!Array.isArray(data.entries) || !Object.prototype.hasOwnProperty.call(data, 'sha')) throw new Error('未得到完整的笔记保存结果。');
      entries = data.entries; recordSHA = data.sha; render(); status.textContent = `${entries.length} 条学习笔记`;
      const saved = entries.find(entry => entry.id === draft.id);
      if (!saved?.revision) throw new Error('笔记缺少保存版本，请重新读取后核对。');
      working.baseline = draft.comment; working.revision = saved.revision; autoPaused = false;
      if (automatic || input.value !== draft.comment) {
        error.textContent = input.value === draft.comment ? '已自动同步' : '刚才的版本已保存，新修改待同步…';
      } else { closeEditor(); working = null; notify('学习笔记已保存'); }
    } catch (failure) {
      if (material === draft.material) {
        autoPaused = true;
        error.textContent = `${failure.message || '保存未完成。'} 草稿已保留。`;
        reload.hidden = false;
      }
    } finally { saving = false; controls(); if (ticket === sequence && connected()) scheduleSave(); }
  }
  function selectionChanged() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      selected = connected() && ready && sourceSHA.length === 64 && dialog.hidden ? window.HUB_TEXT_ANCHOR.capture(roots) : null;
      if (selected) {
        selectButton.style.left = Math.max(12, Math.min(innerWidth - 110, selected.rectangle.left)) + 'px';
        selectButton.style.top = Math.max(12, Math.min(innerHeight - 52, selected.rectangle.bottom + 8)) + 'px';
      }
      controls();
    }, 80);
  }
  async function removeEntry(entry) {
    if (saving || !ready || !connected() || !window.confirm('删除这条笔记？')) return;
    const current = material, ticket = sequence;
    saving = true; controls(); status.textContent = '正在删除…';
    try {
      const data = await api('/api/annotations', { method: 'DELETE', body: { module: current.module,
        resource_id: current.id, id: entry.id, expected_sha: recordSHA, expected_revision: entry.revision } });
      if (ticket !== sequence || material !== current || !connected()) return;
      if (!Array.isArray(data.entries) || !Object.prototype.hasOwnProperty.call(data, 'sha')) throw new Error('未得到完整的删除结果。');
      entries = data.entries; recordSHA = data.sha;
      if (working?.id === entry.id) { closeEditor(); working = null; }
      render(); status.textContent = entries.length ? `${entries.length} 条笔记` : ''; notify('笔记已删除');
    } catch (failure) {
      if (ticket === sequence && material === current) {
        ready = false; status.textContent = `${failure.message || '删除未完成。'} 请重新打开笔记栏核对，草稿仍保留。`;
        if (working) { error.textContent = status.textContent; reload.hidden = false; }
      }
    } finally { saving = false; controls(); }
  }
  add.addEventListener('click', () => open());
  selectButton.addEventListener('pointerdown', event => event.preventDefault());
  selectButton.addEventListener('click', () => {
    if (!selected) return;
    const { rectangle, ...anchor } = selected;
    open(null, { ...anchor, source_sha256: sourceSHA }); selected = null; controls();
  });
  get('reading-note-form').addEventListener('submit', submit);
  input.addEventListener('input', () => {
    if (working && isDirty()) error.textContent = autoPaused ? '草稿已保留，请核对后重试保存。' : '修改待同步…';
    scheduleSave();
  });
  input.addEventListener('compositionstart', () => { composing = true; clearTimeout(saveTimer); });
  input.addEventListener('compositionend', () => { composing = false; scheduleSave(); });
  function cancel(event) {
    if (saving || (isDirty() && !window.confirm('笔记尚未保存，放弃这次修改吗？'))) { event?.preventDefault(); return; }
    closeEditor(); working = null;
  }
  get('cancel-reading-note').addEventListener('click', cancel);
  dialog.addEventListener('cancel', cancel);
  reload.addEventListener('click', async () => {
    const draft = working, text = input.value;
    await load();
    if (!draft) return;
    if (!ready || working !== draft) return;
    const latest = entries.find(entry => entry.id === draft.id);
    if (!latest && draft.revision) {
      needsMerge = true; error.textContent = '这条笔记已在别处删除。草稿仍保留，可复制后新建一条笔记。';
      get('merge-reading-note').hidden = true; save.disabled = true;
    } else if (latest && latest.revision !== draft.revision) {
      needsMerge = true;
      error.textContent = '这条笔记在别处已有新版本。请先核对下方内容，再决定合并；你的草稿仍保留。';
      get('annotation-latest').textContent = latest.comment;
      get('merge-reading-note').hidden = false;
      save.disabled = true;
    } else { needsMerge = false; autoPaused = false; error.textContent = '已读取其他笔记，你的草稿仍保留，可以保存。'; }
    input.value = text;
    controls();
  });
  get('merge-reading-note').addEventListener('click', () => {
    const latest = entries.find(entry => entry.id === working?.id);
    if (!latest) return;
    working.revision = latest.revision; working.baseline = latest.comment;
    needsMerge = false; autoPaused = false;
    get('merge-reading-note').hidden = true; get('annotation-latest').textContent = '';
    error.textContent = '请在输入框合并你的草稿与新版本，再保存。'; controls();
  });
  document.addEventListener('selectionchange', selectionChanged);
  window.addEventListener('resize', selectionChanged);
  controls();
  return Object.freeze({
    isDirty, isSaving: () => saving,
    async refresh() { if (material && connected() && !saving && !working) await load(); },
    mayLeave() {
      if (saving) { notify('笔记正在保存，请稍后再切换。'); return false; }
      return !isDirty() || window.confirm('笔记尚未保存，放弃修改并切换资料吗？');
    },
    pause() { sequence++; ready = false; selected = null; selectButton.hidden = true; panel.hidden = true;
      closeEditor(); CSS.highlights?.delete('hub-reading-note'); controls(); },
    clear() { sequence++; ready = false; entries = []; material = null; working = null;
      selected = null; closeEditor(); list.replaceChildren(); CSS.highlights?.delete('hub-reading-note'); controls(); },
    async setMaterial(next, surfaces, digest) {
      const previous = material;
      material = next; roots = surfaces.filter(Boolean); sourceSHA = digest; entries = [];
      list.replaceChildren();
      CSS.highlights?.delete('hub-reading-note');
      if (!connected()) { this.clear(); panel.hidden = true; return; }
      panel.hidden = false;
      const draft = working && previous?.id === next.id && previous?.module === next.module ? working : null;
      if (!draft) working = null;
      await load();
      if (draft && ready && material === next) {
        draft.material = next; working = draft; quote.textContent = draft.anchor?.quote || '整篇资料的笔记';
        openEditor(); error.textContent = '草稿已保留，请核对后保存。';
      }
    },
  });
};
