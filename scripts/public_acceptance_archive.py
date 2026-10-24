"""Keep selected public-only acceptance evidence in immutable private Git refs."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field

REPOSITORY = 'rujiewu/superintelligence-public-checks'
REPOSITORY_ID = 1428657008
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024


class CapturePlan(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: str = '1.0.0'
    content: list[str]
    ui: list[str]


class FileRecord(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str
    size: int = Field(ge=0, le=MAX_FILE_BYTES)
    sha256: str
    git_blob: str


def blob_sha(raw: bytes) -> str:
    return hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()


def safe_name(name: str) -> bool:
    return bool(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:json|png)', name))


def read_file(folder: Path, name: str) -> bytes:
    path = folder / name
    if not safe_name(name) or path.is_symlink() or not path.is_file():
        raise ValueError('Evidence must be a regular allowlisted file')
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError('Evidence file exceeds bound')
    return path.read_bytes()


def prepare(root: Path, profile: str, source: str, plan: CapturePlan) -> tuple[dict[str, bytes], dict[str, Any]]:
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('Invalid source reference')
    if profile not in {'public-content', 'public-boundary'}:
        raise ValueError('Unknown evidence profile')
    folder = root / 'test-results' / profile
    if folder.is_symlink() or folder.parent.is_symlink():
        raise ValueError('Evidence directory must not be a symlink')
    names = ['ui-report.json', 'report.json'] if profile == 'public-content' else ['report.json']
    selected: dict[str, bytes] = {}
    reports: dict[str, Any] = {}
    capture_records = []
    for name in names:
        if not (folder / name).exists():
            continue
        raw = read_file(folder, name)
        report = json.loads(raw)
        if report.get('status') not in {'PASS', 'FAIL'}:
            raise ValueError('Missing report result')
        if profile == 'public-content':
            key = 'source_commit' if name == 'ui-report.json' else 'expected_source_commit'
            if report.get(key) != source:
                raise ValueError('Report source does not match checkout')
            if name == 'ui-report.json' and any(type(report.get(k)) is not int or report.get(k) != 0 for k in ['real_record_writes', 'model_calls', 'real_api_requests', 'forbidden_requests']):
                raise ValueError('Report is not public synthetic acceptance')
            captures = report.get('screenshots')
            if not isinstance(captures, list) or len(captures) != len(set(captures)):
                raise ValueError('Invalid capture inventory')
            required = plan.ui if name == 'ui-report.json' else plan.content
            for capture in captures:
                if not isinstance(capture, str) or not capture.endswith('.png'):
                    raise ValueError('Invalid capture name')
                image = read_file(folder, capture)
                if not image.startswith(b'\x89PNG\r\n\x1a\n'):
                    raise ValueError('Capture is not a PNG')
                capture_records.append(dict(path=capture, size=len(image), sha256=hashlib.sha256(image).hexdigest(), retained=capture in required))
                if capture in required:
                    selected[capture] = image
            if report['status'] == 'PASS' and not set(required) <= set(captures):
                raise ValueError('Required selected captures are missing')
        selected[name] = raw
        reports[name] = dict(status=report['status'])
    if not reports:
        raise ValueError('No acceptance report to retain')
    selected_bytes = sum(len(raw) for raw in selected.values())
    if selected_bytes > MAX_TOTAL_BYTES:
        raise ValueError(f'Selected evidence exceeds total bound: {selected_bytes} > {MAX_TOTAL_BYTES}')
    records = [FileRecord(path=name, size=len(raw), sha256=hashlib.sha256(raw).hexdigest(), git_blob=blob_sha(raw)).model_dump() for name, raw in sorted(selected.items())]
    manifest = dict(schema_version='1.0.0', source_commit=source, profile=profile, reports=reports,
                    retained_files=records, generated_capture_inventory=capture_records,
                    all_generated_images_retained=False, private_records_included=False,
                    scope='Complete available reports and explicitly selected public/synthetic images; hashes of other generated captures are metadata, not retained image bytes. Archive success does not override failed assertions or grant independent acceptance.')
    selected['evidence-manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2)+'\n').encode()
    return selected, manifest


def guard(env: dict[str, str], head: str, repository: dict[str, Any]) -> str:
    if not (env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_REPOSITORY') == REPOSITORY
            and env.get('GITHUB_ACTOR') == 'rujiewu' and env.get('GITHUB_REF') == 'refs/heads/main'
            and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and env.get('GITHUB_SHA') == head
            and repository.get('id') == REPOSITORY_ID and repository.get('private') is False):
        raise ValueError('Owner main public-capsule runner required')
    run, attempt = env.get('GITHUB_RUN_ID', ''), env.get('GITHUB_RUN_ATTEMPT', '')
    if not (re.fullmatch(r'[1-9][0-9]*', run) and re.fullmatch(r'[1-9][0-9]*', attempt)):
        raise ValueError('Invalid run identity')
    return f'acceptance-evidence/run-{run}-{attempt}'


def persist(api: Callable[..., Any], ref: str, files: dict[str, bytes]) -> dict[str, Any]:
    if not re.fullmatch(r'acceptance-evidence/run-[1-9][0-9]*-[1-9][0-9]*', ref):
        raise ValueError('Invalid immutable evidence reference')
    expected = {name: blob_sha(raw) for name, raw in files.items()}
    prefix = f'repos/{REPOSITORY}/git/'
    found = api('GET', prefix+'matching-refs/heads/'+ref)
    exact = [x for x in found if x.get('ref') == 'refs/heads/'+ref]
    if found and len(exact) != 1:
        raise ValueError('Unexpected evidence references')
    if exact:
        commit = exact[0]['object']['sha']
        tree = api('GET', prefix+'commits/'+commit)['tree']['sha']
    else:
        entries = []
        for name, raw in sorted(files.items()):
            saved = api('POST', prefix+'blobs', dict(content=base64.b64encode(raw).decode(), encoding='base64'))
            if saved['sha'] != expected[name]:
                raise ValueError('Stored blob identity differs')
            entries.append(dict(path=name, mode='100644', type='blob', sha=saved['sha']))
        tree = api('POST', prefix+'trees', dict(tree=entries))['sha']
        commit = api('POST', prefix+'commits', dict(message='Retain public acceptance evidence', tree=tree, parents=[]))['sha']
        # A unique ref is created once. Unknown outcomes are inspected, never replayed here.
        api('POST', prefix+'refs', dict(ref='refs/heads/'+ref, sha=commit))
    actual_ref = api('GET', prefix+'ref/heads/'+ref)
    actual_tree = api('GET', prefix+'trees/'+tree)
    blobs = {x['path']: x['sha'] for x in actual_tree['tree'] if x['type'] == 'blob'}
    if actual_ref['object']['sha'] != commit or actual_tree.get('truncated') or blobs != expected:
        raise ValueError('Actual immutable archive differs')
    return dict(status='PUBLIC_GIT_EVIDENCE_ARCHIVE_VERIFIED', repository=REPOSITORY, private=False,
                ref='refs/heads/'+ref, commit=commit, tree=tree, retained_files=len(files),
                manifest_sha256=hashlib.sha256(files['evidence-manifest.json']).hexdigest(),
                existing_refs_changed=False, histories_deleted=False, billing_changed=False,
                all_generated_images_retained=False)
