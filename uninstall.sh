#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) -ne 0 ]] || { printf 'Run as your desktop user, without sudo.\n' >&2; exit 1; }
if gnome-extensions info work-habbits@local >/dev/null 2>&1; then
    gnome-extensions disable work-habbits@local
fi
if [[ -f ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/work-habbits-desk.service ]]; then
    systemctl --user disable --now work-habbits-desk.service
fi
python3 - <<'PY'
import os
import shutil
from pathlib import Path
home = Path.home()
data = Path(os.environ.get('XDG_DATA_HOME', home / '.local/share'))
for path in [data / 'gnome-shell/extensions/work-habbits@local', home / '.local/share/work-habbits']:
    if path.is_symlink():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)
(Path(os.environ.get('XDG_CONFIG_HOME', home / '.config')) / 'systemd/user/work-habbits-desk.service').unlink(missing_ok=True)
PY
systemctl --user daemon-reload
printf 'Uninstalled work-habbits. Local history and preferences are preserved.\n'
