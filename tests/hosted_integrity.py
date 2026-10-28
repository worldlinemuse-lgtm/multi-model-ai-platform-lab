"""Verify the live GitHub Pages site is serving the exact committed application assets.

This intentionally runs AFTER deployment from GitHub Actions, rather than testing
localhost or trusting the Pages action's success state. No credentials are read.
"""
import argparse
import hashlib
import sys
import time
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent


def shell_assets():
    """Read the service worker's SHELL manifest (minus the site root)."""
    import re
    text = (ROOT / 'sw.js').read_text()
    match = re.search(r"const SHELL=\[(.*?)\];", text, re.S)
    assert match, 'could not parse SHELL from sw.js'
    paths = re.findall(r"""['"](\./[^'"]+)['"]""", match.group(1))
    return tuple(p[2:] for p in paths if p != './')


# The hosted check verifies exactly what the offline shell stages, plus the
# worker script itself and the observability bundles it loads lazily. This
# keeps the list from drifting behind SHELL (the old list silently omitted
# bounded-deflate.js, telemetry-view.js and draw.js).
ASSETS = shell_assets() + (
    'sw.js',
    'observability/dist/otel-local-pilot.js', 'observability/dist/otel-local-metrics.js',
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verify_once(base):
    problems = []
    for path in ASSETS:
        expected = (ROOT / path).read_bytes()
        url = urljoin(base, path)
        try:
            request = Request(url, headers={'User-Agent': 'MultiModelStudio-Hosted-Integrity/1.0', 'Cache-Control': 'no-cache'})
            with urlopen(request, timeout=15) as response:
                actual = response.read(2_000_001)
                status = response.status
                final_url = response.url
            if status != 200 or len(actual) > 2_000_000:
                problems.append(f'{path}: HTTP {status} or response exceeds size limit')
            elif sha256(actual) != sha256(expected):
                problems.append(f'{path}: SHA-256 mismatch local={sha256(expected)} hosted={sha256(actual)} url={final_url}')
        except Exception as error:
            problems.append(f'{path}: {type(error).__name__}: {error}')
    return problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True, help='GitHub Pages output URL (must end in repo root)')
    parser.add_argument('--attempts', type=int, default=18)
    parser.add_argument('--interval', type=float, default=5.0)
    args = parser.parse_args()
    base = args.base_url.rstrip('/') + '/'
    if not base.startswith('https://') or args.attempts < 1 or args.interval < 0:
        parser.error('Use a public HTTPS URL and nonnegative retry limits')
    for attempt in range(1, args.attempts + 1):
        problems = verify_once(base)
        if not problems:
            print(f'PASS: {len(ASSETS)} exact SHA-256 matched hosted assets at {base} (attempt {attempt})')
            return 0
        print(f'Attempt {attempt}/{args.attempts} did not match deployed source ({len(problems)} issues):', flush=True)
        for problem in problems[:5]:
            print('  ' + problem, flush=True)
        if attempt < args.attempts:
            time.sleep(args.interval)
    print('FAIL: hosted GitHub Pages files do not match this checked-out release', flush=True)
    return 1


if __name__ == '__main__':
    sys.exit(main())
