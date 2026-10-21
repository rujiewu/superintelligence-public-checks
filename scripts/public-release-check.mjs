// Fixed-route public release metadata/packet verification. No records, credentials or models.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { capsule } from './public-capsule.mjs';
import { hosting } from './hosting-config.mjs';
const digest = raw => createHash('sha256').update(raw).digest('hex');
const started = Date.now(), deadline = started + 120000;
const report = { status: 'RUNNING', source_commit: process.env.EXPECTED_SOURCE_SHA,
  expected_source_commit: process.env.EXPECTED_SOURCE_SHA, capsule_commit: process.env.EXPECTED_CAPSULE_SHA,
  execution: 'FREE_PUBLIC_GITHUB_HOSTED_FIXED_ROUTE_CHECK', checks: [], record_reads: 0,
  record_writes: 0, model_calls: 0, pages_bytes_checked: process.env.CHECK_PAGES === 'true' };
const record = (name, fields = {}) => report.checks.push({ name, status: 'PASS', ...fields });
async function bytes(url, cap = 65536) {
  const time = Math.min(20000, deadline - Date.now());
  assert.ok(time > 0, 'Release deadline');
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', cache: 'no-store',
    signal: AbortSignal.timeout(time), headers: { 'Origin': hosting.pages_origin } });
  assert.equal(response.status, 200, 'Public HTTP status');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      assert.ok(total <= cap && Date.now() < deadline, 'Source-bound response size/deadline');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
try {
  const bound = capsule();
  const packets = Object.fromEntries(Object.entries(bound.files).filter(([p]) =>
    /^dist\/ui-preview\/data\/(?:catalog-(?:reading|learning|trading|investment)|books\/[a-z0-9-]+)\.json$/.test(p))
    .map(([path, hash]) => [path.slice('dist/ui-preview/'.length), hash]));
  assert.equal(Object.keys(packets).length, 12);
  const origins = process.env.RELEASE_TARGET === 'candidate'
    ? ['https://superintelligence-api-candidate-rujiewuac-8230.vercel.app']
    : process.env.RELEASE_TARGET === 'production'
      ? [hosting.api_origin, 'https://reading-workspace-api.vercel.app', 'https://reading-workspace-api-rujiewuac-8230.vercel.app'] : [];
  assert.ok(origins.length > 0, 'Fixed candidate/production target required');
  for (const origin of origins) {
    const health = JSON.parse(await bytes(origin + '/'));
    assert.deepEqual(health, { service: 'shared-learning-gateway', status: 'ready' });
    const release = JSON.parse(await bytes(origin + '/api/release'));
    assert.equal(release.packaged, true);
    assert.equal(release.source_commit, bound.source_commit);
    assert.equal(release.external_model_calls_allowed, false);
    assert.equal(release.chat_packet_validation, 'sha256-v1');
    assert.deepEqual(release.packets_sha256, packets);
    record('gateway-release', { origin, source_commit: release.source_commit,
      packets_verified: 12, external_model_calls_allowed: false });
  }
  if (report.pages_bytes_checked) {
    for (const path of ['pages-manifest.json', ...Object.keys(packets)]) {
      const local = readFileSync('dist/ui-preview/' + path);
      const served = await bytes(hosting.pages_url + path, local.length);
      assert.equal(served.length, local.length);
      assert.equal(digest(served), bound.files['dist/ui-preview/' + path]);
      record('pages-bytes', { path, bytes: served.length, sha256: digest(served) });
    }
  }
  report.api_origin = origins[0]; report.packets_verified = 12; report.exact_source_checked = true;
  report.external_model_calls_allowed = false; report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.failure = error?.code || error?.name || 'PUBLIC_RELEASE_CHECK_FAILED';
} finally {
  report.elapsed_seconds = Math.round((Date.now() - started) / 1000);
  mkdirSync('test-results/public-boundary', { recursive: true });
  writeFileSync('test-results/public-boundary/report.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
process.exitCode = report.status === 'PASS' ? 0 : 1;
