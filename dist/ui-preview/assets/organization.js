/* Private, serialized model work. Reading and re-rendering never replay an attempt. */
window.HUB_ORGANIZER = ({ api, connected }) => {
  const jobs = new Map(), attempted = new Set();
  let busy = false;
  const pause = () => new Promise(resolve => setTimeout(resolve, 3000));
  const path = selection => '/api/organization?' + new URLSearchParams(Object.entries(selection)
    .filter(([, value]) => value != null));

  function schedule(selection, organization, accept, retry = false) {
    const explicitRetry = retry && (organization?.status === 'FAILED' && organization.retry_known_failure
      || organization?.status === 'UNAVAILABLE' && organization.retry_allowed);
    if (!connected() || !organization?.source_sha256
        || !explicitRetry && !['PENDING', 'PARTIAL', 'RUNNING'].includes(organization.status)) return;
    const key = `${selection.module}:${selection.kind}:${selection.record_id || selection.resource_id}:${organization.source_sha256}`;
    if (jobs.has(key)) { jobs.get(key).accept = accept; void pump(); return; }
    if (attempted.has(key) && !explicitRetry && organization.status !== 'RUNNING') return;
    jobs.set(key, { key, selection, organization, accept, retry: explicitRetry });
    void pump();
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      for (const job of jobs.values()) {
        if (!connected()) break;
        attempted.add(job.key);
        let result = job.retry ? { ...job.organization, status: 'PENDING' } : job.organization;
        try {
          for (let step = 0, polls = 0; step < 10000 && connected(); step++) {
            if (result.status === 'RUNNING') {
              if (polls++ >= 60) break;
              await pause();
              if (!connected()) break;
              result = await api(path(job.selection));
            } else if (['PENDING', 'PARTIAL'].includes(result.status)) {
              result = await api('/api/organization', { method: 'POST', body: {
                ...job.selection, source_sha256: job.organization.source_sha256,
                ...(job.retry ? { retry_known_failure: true } : {}) } });
              job.retry = false;
            } else break;
            if (result.source_sha256 !== job.organization.source_sha256) break;
            if (connected()) job.accept(result);
          }
        } catch {
          if (!connected()) continue;
          // Recover only an authoritative status; a lost model POST is never resent here.
          try {
            let status = await api(path(job.selection));
            for (let poll = 0; status.status === 'RUNNING' && connected() && poll < 60; poll++) {
              await pause();
              if (!connected()) break;
              status = await api(path(job.selection));
            }
            if (connected() && status.source_sha256 === job.organization.source_sha256) job.accept(
              ['PENDING', 'PARTIAL'].includes(status.status) ? { ...status, status: 'UNAVAILABLE', retry_allowed: true } : status);
          } catch { /* Original records and editors are unaffected. */ }
        } finally { jobs.delete(job.key); }
      }
    } finally { busy = false; }
  }
  return Object.freeze({ schedule, retry: (selection, organization, accept) => schedule(selection, organization, accept, true) });
};
