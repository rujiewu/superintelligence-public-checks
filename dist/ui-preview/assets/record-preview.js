/* Only completed, version-bound model organization supplies semantic labels. */
window.HUB_RECORD_PREVIEW = (() => {
  function describe(record, fallback = '学习笔记') {
    const value = record?.organization;
    if (value?.status === 'COMPLETED' && ['gpt-6.1-sol', 'claude-opus-5-5'].includes(value.model)
        && value.reported_model === value.model
        && /^[a-f0-9]{64}$/.test(value.source_sha256 || '')
        && typeof value.title === 'string' && value.title.trim()
        && typeof value.summary === 'string' && value.summary.trim()) {
      return Object.freeze({ title: value.title, summary: value.summary, generated: true });
    }
    const pending = ['PENDING', 'PARTIAL', 'RUNNING'].includes(value?.status);
    return Object.freeze({ title: value?.status === 'EMPTY' ? '新对话' : fallback,
      summary: pending ? '正在理解与整理…' : ['FAILED', 'UNKNOWN', 'UNAVAILABLE', 'INVALID'].includes(value?.status)
        ? '整理未完成，原文仍完整保留。' : '', generated: false });
  }
  return Object.freeze({ describe, conversation: record => describe(record, '讨论'),
    annotation: record => describe(record, '学习笔记') });
})();
