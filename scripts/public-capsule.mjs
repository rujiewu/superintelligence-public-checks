// Public-only runner identity and exact capsule/static byte binding.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const digest = value => createHash('sha256').update(value).digest('hex');
let verified;

export function capsuleRunnerAllowed(env) {
  return env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REPOSITORY === 'rujiewu/superintelligence-public-checks'
    && env.GITHUB_REPOSITORY_ID === '1428657008' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_ACTOR?.toLowerCase() === 'rujiewu'
    && /^[a-f0-9]{40}$/.test(env.EXPECTED_SOURCE_SHA || '')
    && /^[a-f0-9]{40}$/.test(env.EXPECTED_CAPSULE_SHA || '')
    && env.EXPECTED_CAPSULE_SHA === env.GITHUB_SHA
    && !['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(k => env[k]);
}

export function capsule() {
  if (verified) return verified;
  assert.ok(capsuleRunnerAllowed(process.env), 'Owner public capsule runner required');
  const manifest = JSON.parse(readFileSync('capsule-manifest.json'));
  assert.equal(manifest.source_commit, process.env.EXPECTED_SOURCE_SHA);
  assert.equal(manifest.private_records_exported, false);
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.match(path, /^(?:scripts|config|dist\/ui-preview|data\/canon\/nominations|\.github\/workflows)\/[a-zA-Z0-9_./-]+$|^qa-(?:references|book-editions)\.json$|^package(?:-lock)?\.json$/);
    assert.ok(!path.split('/').includes('..'));
    assert.equal(digest(readFileSync(path)), expected, path);
  }
  verified = manifest;
  return verified;
}

export function capsuleContentInputs({ catalogs, manifest, requireTrue, record }) {
  const bound = capsule();
  requireTrue(bound.source_commit === manifest.source_commit, 'CAPSULE_SOURCE_MISMATCH');
  const refs = JSON.parse(readFileSync('qa-references.json'));
  requireTrue(refs.source_commit === manifest.source_commit, 'REFERENCE_SOURCE_MISMATCH');
  for (const check of refs.local_checks) record(check.name, { ...check, execution: 'LOCAL_SOURCE_CHECK_RECEIPT' });
  const item = entry => {
    const found = catalogs[entry.module]?.find(x => x.id === (entry.resource_id || entry.id));
    requireTrue(found, 'CAPSULE_PUBLIC_ID_MISSING');
    return found;
  };
  record('public_capsule_binding', { source_commit: bound.source_commit,
    capsule_commit: process.env.EXPECTED_CAPSULE_SHA, private_source_checks_executed_here: false });
  return { ...refs, continuations: refs.continuations.map(x => ({ ...x, item: item(x.entry) })),
    materials: refs.materials.map(x => ({ ...x, item: item(x) })) };
}
