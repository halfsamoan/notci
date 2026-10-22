"""Check the shared island core against the sibling repositories or their GitHub branches."""

import json
import os
from pathlib import Path
import subprocess
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SELF = json.loads((ROOT / 'extension/metadata.json').read_text(encoding='utf-8'))['uuid'].split('@')[0]
PEERS = tuple(name for name in ('archsport', 'matci', 'notci') if name != SELF)
OWNER = 'halfsamoan'
FILES = (
    'docs/design/design-tokens.json',
    'extension/designTokens.js',
    'extension/dockModel.js',
    'extension/notchDock.js',
    'extension/notchSurface.js',
)


def _branch_name():
    branch = os.environ.get('GITHUB_HEAD_REF') or os.environ.get('GITHUB_REF_NAME')
    if branch:
        return branch
    result = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--abbrev-ref', 'HEAD'],
                            capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else 'main'


def _remote_branch_exists(peer, branch):
    url = f'https://api.github.com/repos/{OWNER}/{peer}/branches/{quote(branch, safe="")}'
    request = Request(url, headers={'Accept': 'application/vnd.github+json',
                                    'User-Agent': 'paired-design-check'})
    try:
        with urlopen(request, timeout=15):
            return True
    except HTTPError as error:
        if error.code == 404:
            return False
        raise


def _remote_files(peer, branch):
    files = {}
    for relative in FILES:
        url = (f'https://raw.githubusercontent.com/{OWNER}/{peer}/'
               f'{quote(branch, safe="/")}/{relative}')
        with urlopen(url, timeout=15) as response:
            files[relative] = response.read()
    return files


def _compare(expected, source, *, warning_only=False):
    mismatches = [name for name in FILES if (ROOT / name).read_bytes() != expected[name]]
    if not mismatches:
        print(f'Shared design files match byte-for-byte ({source})')
        return 0
    message = f'Shared design files differ from {source}: {", ".join(mismatches)}'
    if warning_only:
        print(f'WARNING: {message}')
        return 0
    print(message)
    return 1


def _check_peer(peer):
    sibling = ROOT.parent / peer
    if all((sibling / name).is_file() for name in FILES):
        expected = {name: (sibling / name).read_bytes() for name in FILES}
        return _compare(expected, str(sibling))
    branch = _branch_name()
    try:
        if _remote_branch_exists(peer, branch):
            return _compare(_remote_files(peer, branch), f'{peer}:{branch}')
        return _compare(_remote_files(peer, 'main'), f'{peer}:main (same-name peer branch absent)',
                        warning_only=True)
    except (HTTPError, URLError) as error:
        print(f'WARNING: {peer} is not reachable on GitHub ({error}); skipped')
        return 0


def main() -> int:
    return max(_check_peer(peer) for peer in PEERS)


if __name__ == '__main__':
    raise SystemExit(main())
