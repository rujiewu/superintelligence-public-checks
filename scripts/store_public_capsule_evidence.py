#!/usr/bin/env python3
"""Retain reports and selected public/synthetic captures in this capsule repo only."""
from pathlib import Path
import json
import os
import subprocess

from public_acceptance_archive import CapturePlan, REPOSITORY, guard, persist, prepare


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    env = {k: v for k, v in os.environ.items() if k.lower() not in {'http_proxy', 'https_proxy', 'all_proxy'}}
    if env.get('EXPECTED_CAPSULE_SHA') != head:
        raise ValueError('Evidence capsule differs from dispatched checkout')
    def api(method, path, payload=None):
        command = ['gh', 'api', path, '--method', method]
        if payload is not None:
            command += ['--input', '-']
        result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                                text=True, capture_output=True, env=env, timeout=45)
        if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
            raise RuntimeError('Evidence Git API failed; inspect immutable ref before retry')
        return json.loads(result.stdout)
    ref = guard(env, head, api('GET', 'repos/' + REPOSITORY))
    capsule = json.loads((root / 'capsule-manifest.json').read_bytes())
    source = env.get('EXPECTED_SOURCE_SHA')
    if capsule['source_commit'] != source:
        raise ValueError('Evidence source mismatch')
    plan = CapturePlan.model_validate_json((root / 'config/public_acceptance_capture_plan.json').read_bytes())
    files, manifest = prepare(root, 'public-content', source, plan)
    manifest.update(capsule_commit=head, evidence_repository=REPOSITORY,
                    private_source_checks_executed_here=False)
    files['evidence-manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    result = persist(api, ref, files)
    result.update(source_commit=source, capsule_commit=head, report_statuses=manifest['reports'])
    (root / 'test-results/public-content/archive-receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
