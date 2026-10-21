#!/usr/bin/env python3
"""Check the ADR 0060 cutover anonymously; never read records or call a model."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

OLD_REPOSITORY_ID = 1412782116
CLEAN_REPOSITORY_ID = 1426722654
OLD_COMMIT = '41bf8276611c08c6de694f446192d37f6fcb7e25'
PUBLIC_REPOSITORY = 'rujiewu/superintelligence-workspace'
ARCHIVE_REPOSITORY = 'rujiewu/superintelligence-workspace-history-20261020'
IMMUTABLE_HOSTS = (
    'superintelligence-62gks98ck-rujiewuac-8230.vercel.app',
    'superintelligence-c2tezy1eu-rujiewuac-8230.vercel.app',
    'superintelligence-mj1065hfa-rujiewuac-8230.vercel.app',
)
PRODUCTION_HOSTS = (
    'superintelligence-api-candidate-rujiewuac-8230.vercel.app',
    'superintelligence-api-rujiewuac-8230.vercel.app',
    'reading-workspace-api.vercel.app',
    'reading-workspace-api-rujiewuac-8230.vercel.app',
)
MAX_METADATA_BYTES = 2_000_000


def verify(client: httpx.Client, packet_hashes: dict[str, str]) -> dict:
    """Verify fixed historical URLs and current aliases without authentication."""
    if client.headers.get('Authorization') or client.cookies or client.auth is not None:
        raise ValueError('Anonymous verification requires no credentials or cookies')
    checks: list[dict] = []
    deadline = time.monotonic() + 180

    def get(url: str, *, body: bool = False, error_body: bool = False) -> tuple[int, str, bytes]:
        for attempt in range(2):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('Public boundary verification deadline exceeded')
            try:
                client.cookies.clear()
                with client.stream('GET', url, timeout=min(15, remaining),
                                   follow_redirects=False) as response:
                    data = bytearray()
                    if (body and response.status_code == 200) or (error_body and response.status_code == 422):
                        for chunk in response.iter_bytes():
                            if time.monotonic() >= deadline:
                                raise ValueError('Public boundary verification deadline exceeded')
                            data.extend(chunk)
                            if len(data) > MAX_METADATA_BYTES:
                                raise ValueError('Public metadata exceeds byte bound')
                    return response.status_code, response.headers.get('location', ''), bytes(data)
            except httpx.TransportError:
                if attempt:
                    raise
        raise AssertionError('Unreachable retry state')

    denied_urls = [
        f'https://api.github.com/repositories/{OLD_REPOSITORY_ID}',
        f'https://api.github.com/repos/{ARCHIVE_REPOSITORY}',
        f'https://api.github.com/repos/{PUBLIC_REPOSITORY}/commits/{OLD_COMMIT}',
        f'https://raw.githubusercontent.com/{ARCHIVE_REPOSITORY}/{OLD_COMMIT}/data/catalog-trading.json',
        f'https://raw.githubusercontent.com/{PUBLIC_REPOSITORY}/{OLD_COMMIT}/data/catalog-trading.json',
        'https://rujiewu.github.io/superintelligence-workspace-history-20261020/pages-manifest.json',
    ]
    for url in denied_urls:
        commit_lookup=url==f'https://api.github.com/repos/{PUBLIC_REPOSITORY}/commits/{OLD_COMMIT}'
        status, _, raw = get(url,error_body=commit_lookup)
        no_commit=False
        if commit_lookup and status==422:
            try:
                error=json.loads(raw)
            except (ValueError,UnicodeDecodeError):
                error={}
            no_commit=isinstance(error,dict) and error.get('message')==f'No commit found for SHA: {OLD_COMMIT}'
        checks.append(dict(url=url,kind='historical-export-denied',status=status,
                           passed=status==404 or no_commit,
                           denial_reason='EXACT_COMMIT_NOT_FOUND' if no_commit else None))
    for host in IMMUTABLE_HOSTS:
        for path in ['/', '/api/release']:
            url = 'https://' + host + path
            status, location, _ = get(url)
            target = urlsplit(location).hostname or ''
            denied = status in {401,403} or (status in {302,307} and
                     (target == 'vercel.com' or target.endswith('.vercel.com')))
            checks.append(dict(url=url,kind='immutable-deployment-denied',status=status,passed=denied))
    url = f'https://api.github.com/repos/{PUBLIC_REPOSITORY}'
    status, _, raw = get(url, body=True)
    repository = json.loads(raw) if status==200 else {}
    checks.append(dict(url=url,kind='clean-public-repository',status=status,
                       passed=status==200 and repository.get('id')==CLEAN_REPOSITORY_ID
                       and repository.get('private') is False))
    for host in PRODUCTION_HOSTS:
        url = 'https://' + host + '/api/release'
        status, _, raw = get(url, body=True)
        release = json.loads(raw) if status==200 else {}
        checks.append(dict(url=url,kind='public-production-packets',status=status,
                           source_commit=release.get('source_commit'),
                           passed=status==200 and release.get('packaged') is True
                           and release.get('packets_sha256')==packet_hashes))
    passed = all(row['passed'] for row in checks)
    return dict(status='PASS' if passed else 'FAIL',checks=checks,
                requests_are_anonymous=True,record_reads=0,record_writes=0,model_calls=0,
                deleted_histories=0,external_cache_erasure_claimed=False,
                scope='Fixed old Git/Pages URLs, three immutable deployments and three production aliases plus a clean candidate alias. Owner-only archive preservation and project-wide protection configuration require separate authenticated receipts.')


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',type=Path,default=Path('dist/shared-backend/backend-manifest.json'))
    parser.add_argument('--output',type=Path,default=Path('test-results/public-boundary/report.json'))
    args=parser.parse_args()
    manifest=json.loads(args.manifest.read_text())
    with httpx.Client(trust_env=False,follow_redirects=False,
                      headers={'User-Agent':'SuperIntelligence-public-boundary-verification','Cache-Control':'no-cache'}) as client:
        result=verify(client,manifest['packets_sha256'])
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    raise SystemExit(main())
