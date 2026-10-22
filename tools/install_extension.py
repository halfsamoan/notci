"""Per-user Ubuntu install/upgrade with staged schema compilation and backup."""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


UUID = 'notci@local'


def updates_supported(gsettings_output=None, desktop_paths=None, *, gsettings_command=None):
    """Return whether GNOME can apply extension-updates on the next Shell init."""
    if gsettings_output is None:
        command = gsettings_command or shutil.which('gsettings')
        if not command:
            return False
        try:
            result = subprocess.run([command, 'get', 'org.gnome.shell', 'allow-extension-installation'],
                                    text=True, capture_output=True, timeout=5, check=False,
                                    env={**os.environ, 'LC_ALL': 'C'})
        except (OSError, subprocess.TimeoutExpired):
            return False
        if result.returncode != 0:
            return False
        gsettings_output = result.stdout
    if str(gsettings_output).strip().lower() != 'true':
        return False
    if desktop_paths is None:
        candidates = [Path('/usr/share/applications/org.gnome.Extensions.desktop')]
        for base in [Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')),
                     *(Path(item) for item in os.environ.get('XDG_DATA_DIRS', '/usr/local/share:/usr/share').split(':') if item)]:
            candidates.extend(base / 'applications' / name for name in (
                'org.gnome.Extensions.desktop', 'com.mattjakeman.ExtensionManager.desktop'))
        desktop_paths = candidates
    return any(Path(path).is_file() for path in desktop_paths)


def choose_install_path(existing, *, upgrade=False, direct=False, supported=False):
    if not existing:
        return 'initial'
    if direct:
        return 'direct'
    if upgrade and supported:
        return 'staged'
    if upgrade:
        return 'direct'
    return 'refuse'


def running_version(uuid=UUID, *, command=None):
    """Read the Shell's cached extension version and state without exposing user data."""
    executable = command or shutil.which('gnome-extensions')
    if not executable:
        return None, None
    try:
        result = subprocess.run([executable, 'info', uuid], text=True, capture_output=True,
                                timeout=5, check=False, env={**os.environ, 'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    if result.returncode != 0:
        return None, None
    version = re.search(r'^\s*Version:\s*(\d+)\s*$', result.stdout, re.M)
    state = re.search(r'^\s*State:\s*(\S+)\s*$', result.stdout, re.M)
    return (int(version.group(1)) if version else None,
            state.group(1) if state else None)


def verify_identity(path):
    metadata = json.loads((path / 'metadata.json').read_text(encoding='utf-8'))
    if metadata.get('uuid') != UUID:
        raise SystemExit(f'다른 확장을 덮어쓰지 않습니다: {path}')


def prepare_staging(source, parent, compiler):
    staging = Path(tempfile.mkdtemp(prefix='.notci-stage-', dir=parent))
    try:
        shutil.copytree(source / 'extension', staging, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('gschemas.compiled'))
        subprocess.run([compiler, '--strict', str(staging / 'schemas')], check=True)
        verify_identity(staging)
        return staging
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def prune_backups(backup_root, keep=5):
    backups = sorted((path for path in Path(backup_root).glob('extension-*')
                      if path.is_dir() and not path.is_symlink()), key=lambda path: path.name)
    for obsolete in backups[:-keep]:
        shutil.rmtree(obsolete)


def _replace_direct(staging, target, parked):
    if target.exists():
        target.rename(parked)
    try:
        staging.rename(target)
    except OSError:
        if parked and parked.exists() and not target.exists():
            parked.rename(target)
        raise
    if parked:
        shutil.rmtree(parked)


def _pending_path(app_state_dir):
    return app_state_dir / 'pending-relogin.json'


def _write_pending_relogin(app_state_dir, installed, running):
    app_state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    app_state_dir.chmod(0o700)
    path = _pending_path(app_state_dir)
    path.write_text(json.dumps({'installed': installed, 'running': running,
                                'session': os.environ.get('XDG_SESSION_TYPE', ''),
                                'at': datetime.now(timezone.utc).isoformat()}, indent=2) + '\n',
                    encoding='utf-8')
    path.chmod(0o600)
    return path


def _install_into_updates(staging, updates_root, update_target):
    updates_root.mkdir(parents=True, exist_ok=True)
    replaced = update_target.exists()
    if update_target.is_symlink():
        raise SystemExit(f'기존 대기 업데이트가 심볼릭 링크입니다. 보존했습니다: {update_target}')
    if replaced:
        shutil.rmtree(update_target)
    staging.rename(update_target)
    return replaced


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--upgrade', action='store_true', help='Safely stage this extension for the next GNOME Shell start')
    parser.add_argument('--direct', action='store_true', help='Replace the installed files now; a Shell relogin/restart may still be required')
    args = parser.parse_args()
    if sys.platform != 'linux':
        raise SystemExit('Ubuntu GNOME에서 실행하세요.')
    if 'GNOME' not in os.environ.get('XDG_CURRENT_DESKTOP', '').upper():
        raise SystemExit('GNOME 데스크톱 세션에서 실행하세요.')
    if os.geteuid() == 0:
        raise SystemExit('sudo 없이 데스크톱 사용자로 실행하세요.')
    compiler = shutil.which('glib-compile-schemas')
    if not compiler:
        raise SystemExit('glib-compile-schemas가 필요합니다: sudo apt install libglib2.0-bin')
    source = Path(__file__).resolve().parents[1]
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
    parent = data / 'gnome-shell/extensions'
    target = parent / UUID
    updates_root = data / 'gnome-shell/extension-updates'
    update_target = updates_root / UUID
    if target.is_symlink() or (target.exists() and target.resolve().parent != parent.resolve()):
        raise SystemExit('예상하지 않은 확장 경로입니다. 기존 설치를 보존했습니다.')
    if target.exists() and not (args.upgrade or args.direct):
        raise SystemExit('기존 설치를 보존했습니다. 업데이트하려면 --upgrade를 사용하세요.')
    parent.mkdir(parents=True, exist_ok=True)
    staging = prepare_staging(source, parent, compiler)
    new_metadata = json.loads((staging / 'metadata.json').read_text(encoding='utf-8'))
    installed_version = int(new_metadata['version'])
    if target.exists():
        verify_identity(target)
        backup_root = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'notci/backups'
        backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup = backup_root / datetime.now().strftime('extension-%Y%m%d-%H%M%S-%f')
        shutil.copytree(target, backup)
        prune_backups(backup_root)
        print(f'이전 확장 백업: {backup}')
    update_support = updates_supported() if target.exists() and args.upgrade and not args.direct else False
    strategy = choose_install_path(target.exists(), upgrade=args.upgrade, direct=args.direct,
                                   supported=update_support)
    can_stage = strategy == 'staged'
    if can_stage:
        replaced = _install_into_updates(staging, updates_root, update_target)
        if replaced:
            print('이전 대기 스테이징을 교체했습니다.')
        destination = update_target
        print(f'다음 로그인 때 자동 적용: {destination}')
    else:
        parked = None
        if update_target.is_symlink():
            raise SystemExit(f'기존 대기 업데이트가 심볼릭 링크입니다. 보존했습니다: {update_target}')
        if update_target.exists():
            shutil.rmtree(update_target)
            print('기존 대기 업데이트를 제거했습니다.')
        if target.exists():
            parked = parent / f'.notci-previous-{datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")}'
        _replace_direct(staging, target, parked)
        destination = target
        if args.direct or (args.upgrade and not update_support):
            print('직접 교체했습니다. GNOME이 이전 모듈을 캐시했을 수 있습니다. 로그아웃·로그인하세요.')
        else:
            print('최초 설치를 마쳤습니다.')
    print(f'설치됨: {destination}')
    current_version, current_state = running_version()
    state_dir = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'notci'
    if can_stage or (current_version is not None and current_version != installed_version):
        pending = _write_pending_relogin(state_dir, installed_version, current_version)
        running_text = f'v{current_version}' if current_version is not None else '확인 불가'
        print(f'현재 세션은 {running_text} 유지, 설치 버전은 v{installed_version}입니다. 로그아웃·로그인 후 적용됩니다. ({current_state or "상태 확인 불가"})')
        if can_stage:
            print('Wayland: 로그아웃·로그인 / X11: Alt+F2 r 가능')
        print(f'재로그인 대기 정보: {pending}')
    elif args.direct and current_state:
        print(f'현재 확장 상태: {current_state}. 새 코드 적용에는 재로그인이 필요할 수 있습니다.')
    print(f'설정창: gnome-extensions prefs {UUID}')


if __name__ == '__main__':
    main()
