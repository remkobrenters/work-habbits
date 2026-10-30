#!/usr/bin/env python3
"""Export only public project files, without local configuration or caches."""

import stat
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    '.gitignore',
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'Makefile',
    'pyproject.toml',
    'requirements.txt',
    'requirements-bluetooth.txt',
    'requirements-dev.txt',
    'install.sh',
    'uninstall.sh',
    'status.sh',
    'work-habbits-desk.service',
    'desk_monitor.py',
    'desk_service.py',
    'input_monitor.py',
]
DIRECTORIES = ['extension', 'tests', 'scripts', '.github', 'docs']


def main():
    files = [ROOT / name for name in FILES]
    for name in DIRECTORIES:
        files.extend(
            path
            for path in (ROOT / name).rglob('*')
            if path.is_file()
            and not path.is_symlink()
            and '__pycache__' not in path.parts
            and path.name != 'gschemas.compiled'
        )
    target = ROOT / 'dist/work-habbits-source.zip'
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(set(files)):
            if path.is_symlink():
                raise ValueError(f'Cannot package symlink: {path.name}')
            relative = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(f'work-habbits/{relative}', date_time=(2026, 1, 1, 0, 0, 0))
            mode = 0o755 if relative.endswith('.sh') else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    print(target.relative_to(ROOT))


if __name__ == '__main__':
    main()
